import { onUpdatedAST } from "./extension";
import { AST_NODE_TYPES, parse } from "@typescript-eslint/typescript-estree";
import * as path from "path";
import * as fse from "fs-extra";
import { isForInStatement } from "typescript";
import { Program, Node } from "@typescript-eslint/typescript-estree/dist/ts-estree/ts-estree";
import { EnterExitTraverser } from "./enterExitTraverser";
import prettyBytes = require("pretty-bytes");
import * as builtinModules from "builtin-modules";

let builtinModulesSet = new Set(builtinModules);

const extensions = [".ts", ".js", ".tsx", ".jsx"];

const realRequire = eval("require");
function getResolvedPath(importSpec: string, userFileName: string) {
    for (let extension of [""].concat(extensions)) {
        try {
            return realRequire.resolve(importSpec + extension, { paths: [path.dirname(userFileName)] });
        } catch { }
    }
    return undefined;
}

function getImports(allNodes: Node[]): {
    importSpec: string;
    node: Node;
}[] {
    let importNodes: {
        importSpec: string;
        node: Node;
    }[] = [];

    for (let node of allNodes) {
        if (node.type === AST_NODE_TYPES.ImportDeclaration) {
            if (node.importKind === "value") {
                if (node.source.type === AST_NODE_TYPES.Literal) {
                    importNodes.push({ importSpec: node.source.value as string, node });
                }
            }
        } else if (node.type === AST_NODE_TYPES.CallExpression) {
            if (node.callee.type === AST_NODE_TYPES.Identifier && node.callee.name === "require") {
                if (node.arguments.length === 1) {
                    let arg = node.arguments[0];
                    if (arg.type === AST_NODE_TYPES.Literal) {
                        importNodes.push({ importSpec: arg.value as string, node });
                    }
                }
            }
        }
    }

    return importNodes;
}

interface FileParseObj {
    filePath: string;
    fileSize: number;
    fileImportSpecs: Set<string>;
    lastModifiedTime: number;
    parseError: string;
}
// TODO: Add a recheck loop for this.
let fileParseCache: Map<string, FileParseObj> = new Map();

async function parseFile(filePath: string): Promise<FileParseObj> {
    let obj = fileParseCache.get(filePath);
    if (!obj) {
        obj = {
            filePath,
            fileSize: 0,
            fileImportSpecs: new Set(),

            lastModifiedTime: 0,
            parseError: "",
        };

        if (!builtinModulesSet.has(filePath)) {
            let stat: fse.Stats | undefined;
            try {
                stat = await fse.stat(filePath);
            } catch (e) {
                obj.parseError = e.stack;
            }
            if (stat) {
                obj.fileSize = stat.size;
                obj.lastModifiedTime = stat.mtimeMs;
            }

            if (stat && obj && extensions.some(x => filePath.endsWith(x))) {
                let fileContents = await fse.readFile(filePath);

                let ast: Program | undefined;
                try {
                    ast = parse(fileContents.toString(), {
                        module: true,
                        ts: true,
                        jsx: true,
                        next: true,
                        loc: true,
                        ranges: true,
                        raw: true,
                    });
                } catch (e) {
                    obj.parseError = e.stack;
                }

                if (ast) {
                    let allNodes: Node[] = [];
                    new EnterExitTraverser({
                        enter: node => {
                            allNodes.push(node);
                        }
                    }).traverse(ast);

                    for (let importObj of getImports(allNodes)) {
                        obj.fileImportSpecs.add(importObj.importSpec);
                    }
                }
            }
        }

        fileParseCache.set(filePath, obj);
    }
    return obj;
}

async function getAllFileDependencies(filePath: string): Promise<FileParseObj[]> {

    let results: FileParseObj[] = [];

    let pendingFiles: string[] = [filePath];
    let addedFiles = new Set<string>();
    addedFiles.add(filePath);

    while (pendingFiles.length > 0) {
        let filePathProvider = pendingFiles.shift();
        if (!filePathProvider) continue;

        let parseObj = await parseFile(filePathProvider);
        results.push(parseObj);

        for (let importSpec of parseObj.fileImportSpecs) {
            let fileToAdd = getResolvedPath(importSpec, filePathProvider);
            if (!addedFiles.has(fileToAdd)) {
                addedFiles.add(fileToAdd);
                pendingFiles.push(fileToAdd);
            }
        }
    }

    return results;
}


onUpdatedAST(async ({ setDecoration, traverse, doc }) => {
    let allNodes: Node[] = [];

    traverse({
        enter: node => {
            allNodes.push(node);
        }
    });

    let allFiles: Map<string, {
        obj: FileParseObj;
        nodes: Set<Node>;
    }> = new Map();

    for (let importObj of getImports(allNodes)) {
        let resolvedPath = getResolvedPath(importObj.importSpec, doc.fileName);
        if (!resolvedPath) {
            setDecoration({
                node: importObj.node,
                after: {
                    contentText: `Cannot resolve path`,
                    //contentText: resolvedPath,
                    color: `hsl(0, 75%, 75%)`,
                    margin: "0px 0px 0px 8px"
                }
            });
            continue;
        }
        let dependencies = await getAllFileDependencies(resolvedPath);

        for (let dependency of dependencies) {
            let dependObj = allFiles.get(dependency.filePath);
            if (!dependObj) {
                dependObj = {
                    obj: dependency,
                    nodes: new Set()
                };
                allFiles.set(dependency.filePath, dependObj);
            }
            dependObj.nodes.add(importObj.node);
        }
    }

    let nodeCosts: Map<Node, {
        count: number;
        fullCost: number;
        costWithSharedSplit: number;
        notFoundFiles: Set<string>;
    }> = new Map();

    for (let [filePath, fileObj] of allFiles) {
        for (let node of fileObj.nodes) {
            let costs = nodeCosts.get(node);
            if (!costs) {
                costs = {
                    count: 0,
                    fullCost: 0,
                    costWithSharedSplit: 0,
                    notFoundFiles: new Set(),
                };
                nodeCosts.set(node, costs);
            }
            costs.count++;
            costs.fullCost += fileObj.obj.fileSize;
            if (fileObj.obj.parseError) {
                costs.notFoundFiles.add(fileObj.obj.filePath);
            }
            costs.costWithSharedSplit += fileObj.obj.fileSize / fileObj.nodes.size;
        }
    }

    for (let [node, costsObj] of nodeCosts) {
        let color = `hsl(283, 75%, 75%)`;
        let hoverMessage = `${costsObj.count} files`;
        let message = `${prettyBytes(costsObj.fullCost).replace(" ", "")}`;
        if (costsObj.costWithSharedSplit !== costsObj.fullCost) {
            message += ` (${prettyBytes(costsObj.costWithSharedSplit).replace(" ", "")})`;
        }
        if (costsObj.notFoundFiles.size > 0) {
            color = `hsl(0, 75%, 75%)`;
            message += `, ${costsObj.notFoundFiles.size} not found`;
            hoverMessage += `, cannot find: ${Array.from(costsObj.notFoundFiles).join(", ")}`;
        }
        setDecoration({
            node,
            after: {
                contentText: message,
                //contentText: resolvedPath,
                //backgroundColor: "blue",
                color,
                margin: "0px 0px 0px 8px",
            },
            hoverMessage
        });
    }
});
