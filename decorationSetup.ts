import { triggerDecorationChange, onUpdatedAST, watchFile, statFileFromDiskOrEditor, readFileFromDiskOrEditor } from "./extension";
import { AST_NODE_TYPES, parse } from "@typescript-eslint/typescript-estree";
import * as path from "path";
import * as fse from "fs-extra";
import { isForInStatement } from "typescript";
import { Program, Node, Identifier } from "@typescript-eslint/typescript-estree/dist/ts-estree/ts-estree";
import { EnterExitTraverser } from "./enterExitTraverser";
import * as prettyBytes from "pretty-bytes";
import * as builtinModules from "builtin-modules";
import * as child_process from "child_process";
import { parseClosed } from "close-parser/parseClosed";
import "net";
import * as fs from "fs";
import * as vscode from "vscode";
import * as os from "os";

//todonext
// Ah, so... taking every file by itself, finding the full recursive cost without deduping,
//  we can arrange them from smallest to largest. And then remove everything that takes up less
//  than 25% of the total size (or just take the one just above 25%, or any percent really...).
//  Then we look at this, and decide if it is okay. If it is... we whitelist it, which just means
//  that whenever anything imports it pretends as if it didn't.
//  - Hmm... maybe we should sort by unique cost instead? Or... amortized cost? That becomes tricky.
//      Maybe for every import under a module, we find the fewest files we can remove (assuming we also
//      remove the module) that will remove that import. AND, we don't consider removals that would also
//      remove our module. Or, or maybe the amount of files OR specific imports we can remove? Hmm... it's tricky,
//      as our module will be in the import tree multiple times anyway... ugh, idk.
//      - So amoritized and unique cost are hard, so maybe don't do them.
//  But anyway, so some removing some files won't reduce the overall size by too much, as they will only
//      include shared dependencies.
//  OH! We could just find the file which if we replaced it with nothing would reduce the file size by the most?
//      So... our root files will come up first, and we will have to filter through those... ugh... but it will mostly
//      be root imports... Well, hopefully at some point we will get through those, and then we can get onto the rest?
//      - And maybe after whitelisting an import, we also replace it, so we don't have to deal with things constantly looping
//          back to the root with cyclic dependencies?


const requireHelperText = require("raw-loader!./requireHelper.js").default;
const requireHelperPath = os.tmpdir() + "/requireHelper.js";
fs.writeFileSync(requireHelperPath, requireHelperText);

let builtinModulesSet = new Set(builtinModules);

const extensions = [".ts", ".js", ".tsx", ".jsx"];

function b(value: number) {
    return prettyBytes(value).replace(" ", "");
}

let requireResolve: (
    (id: string, path: string) => Promise<string>
) | undefined;

function getRequireResolve(): (id: string, path: string) => Promise<string> {
    // electron does something weird to require.resolve, but only in release mode? Maybe it is something to do
    //  with my paths... but I believe I am passing absolute paths everything... so idk...
    if (!(process.versions as any).electron) {
        return (id: string, path: string) => {
            let resolved = eval("require").resolve(id, { paths: [path] }) as string;
            return Promise.resolve(resolved);
        };
    }

    async function createSocket() {
        let proc = child_process.spawn("node", [requireHelperPath], {});
        proc.on("error", e => {
            debugger;
            (vscode.window.showInformationMessage(`Process error ${e.stack}!`));
        });
        proc.stderr?.on("data", value => {
            debugger;
            console.error(value);
        });
        proc.on("exit", () => {
            debugger;
        });

        let nextSeqNum = 1;
        let callbacks: { [seqNum: number]: (result: string) => void } = {};
        let bufferLine: Buffer[] = [];
        function flushLine() {
            let buffer = Buffer.concat(bufferLine);
            bufferLine = [];
            try {
                let obj = JSON.parse(buffer.toString()) as ({ result: string, seqNum: number } | { error: string, seqNum: number });
                let callback = callbacks[obj.seqNum];
                delete callbacks[obj.seqNum];
                if ("error" in obj) {
                    callback(Promise.reject(obj.error) as any);
                } else {
                    callback(Promise.resolve(obj.result) as any);
                }
            } catch (e) {
                throw new Error(`Error when parsing ${buffer.toString()}\n${e.stack}`);
            }
        }
        async function request(id: string, path: string): Promise<string> {
            let seqNum = nextSeqNum++;
            proc.stdin?.write(JSON.stringify({ id, path, seqNum }) + "\0");
            return new Promise<string>(resolve => {
                callbacks[seqNum] = resolve;
            });
        }
        proc.stdout?.on("data", data => {
            data = Buffer.from(data);
            let startIndex = 0;
            for (let i = 0; i < data.length; i++) {
                if (data[i] === 0) {
                    bufferLine.push(data.slice(startIndex, i));
                    flushLine();
                    startIndex = i + 1;
                }
            }
            bufferLine.push(data.slice(startIndex));
        });

        return request;
    }

    let promise = createSocket();
    return async (id: string, path) => {
        return await (await promise)(id, path);
    };
}

type ResolvedObj = { result: string } | { error: string };

// JSON.stringify({ importSpec, userFileName }) => string
let resolvedCache: Map<string, Promise<ResolvedObj>> = new Map();
async function getResolvedPath(importSpec: string, userFileName: string): Promise<ResolvedObj> {
    let hash = JSON.stringify({ importSpec, userFileName });
    let value = resolvedCache.get(hash);
    if (!value) {
        value = getResolvedPathInternal(importSpec, userFileName);
        resolvedCache.set(hash, value);
    }
    return value;
}
async function getResolvedPathInternal(importSpec: string, userFileName: string): Promise<ResolvedObj> {
    let error = "";
    for (let extension of [""].concat(extensions)) {
        try {
            //todonext;
            // And... the whole thing becomes useless when we have unused imports. So... time to make our closed variables
            //  stuff a library...

            // We have to jump through some hoops, as it looks like require inside of vs code extensions (electron?) doesn't
            //  work the same as it does in nodejs...
            //todonext
            // Too slow, make it faster by leaving the process open
            requireResolve = requireResolve || getRequireResolve();
            let result = await requireResolve(importSpec + extension, path.dirname(userFileName));
            return {
                result,
                /*
                result: await new Promise<string>((resolve, reject) => {
                    child_process.execFile(
                        "node",
                        // IMPORTANT! Change this to not just exec user generated test! Escape it in some way, at least!
                        //  (or maybe JSON.stringify will be enough?)
                        ["-e", `console.log(require.resolve('${JSON.stringify(importSpec + extension).slice(1, -1)}', ${JSON.stringify({ paths: [path.dirname(userFileName)] })}))`],
                        (error, stdout) => {
                            if (error) {
                                reject(error);
                            } else {
                                resolve(stdout.trimEnd());
                            }
                        }
                    );
                })
                */
            };
        } catch (e) {
            error = error || e.stack;
        }
    }
    return {
        error
    };
}

function getImports(ast: Node, allNodes: Node[], fullFile: string): {
    unused: boolean;
    importSpec: string;
    node: Node;
}[] {
    let importNodes: {
        unused: boolean;
        importSpec: string;
        node: Node;
    }[] = [];

    let usedIdentifiers: Set<Node> = new Set();

    parseClosed(
        fullFile,
        ast,
        function onDeclare(obj, scope) { },
        function onAccess(scope, name, pos, y, z, declObj) {
            if (declObj?.identifier) {
                usedIdentifiers.add(declObj?.identifier);
            }
        }
    );

    for (let node of allNodes) {
        if (node.type === AST_NODE_TYPES.ImportDeclaration) {
            if (node.importKind === "value") {
                if (node.source.type === AST_NODE_TYPES.Literal) {
                    importNodes.push({
                        importSpec: node.source.value as string,
                        node,
                        unused: node.specifiers.length > 0 && !node.specifiers.some(x => usedIdentifiers.has(x.local)),
                    });
                }
            }
        } else if (node.type === AST_NODE_TYPES.CallExpression) {
            if (node.callee.type === AST_NODE_TYPES.Identifier && node.callee.name === "require") {
                if (node.arguments.length === 1) {
                    let arg = node.arguments[0];
                    if (arg.type === AST_NODE_TYPES.Literal) {
                        importNodes.push({
                            importSpec: arg.value as string,
                            node,
                            // NOTE: If it is a typescript or ES6 import we can assume (or hope) it will be stripped when we bundle it.
                            //  HOWEVER, I assume if it is a vanilla require there won't be a bundling/transpilation stage to strip the import?
                            //  Also, it's annoying to find the Identifier this expression is assigned to...
                            unused: false
                        });
                    }
                }
            }
        }
    }

    return importNodes;
}

let viewDependencies: Map<string, Set<string>> = new Map();
let viewReverseDependencies: Map<string, Set<string>> = new Map();

interface FileParseObj {
    filePath: string;
    fileSize: number;
    fileImportSpecs: Set<string>;
    lastModifiedTime: number;
    parseError: string;

    readTime: number;
    parseTime: number;
}
// TODO: Add a recheck loop for this.
let fileParseCache: Map<string, { value: Promise<FileParseObj>, invalidate: () => void }> = new Map();

function parseFile(filePath: string): { value: Promise<FileParseObj>, invalidate: () => void } {
    let obj = fileParseCache.get(filePath);
    if (!obj) {
        let state: "loaded" | "pending" | "pendingInvalidate" = "loaded";
        function invalidate() {
            if (state === "pending" || state === "pendingInvalidate") {
                state = "pendingInvalidate";
                return;
            }
            state = "pending";
            let promise = (async () => {
                try {
                    return await parseFileInternal(filePath);
                } finally {
                    if ((state as any) === "pendingInvalidate") {
                        state = "loaded";
                        invalidate();
                    }
                    state = "loaded";

                    let users = viewReverseDependencies.get(filePath);
                    if (users) {
                        for (let user of users) {
                            triggerDecorationChange(user);
                        }
                    }
                }
            })();
            fileParseCache.set(filePath, { value: promise, invalidate });
        }
        invalidate();
        obj = fileParseCache.get(filePath);
        if (!obj) throw new Error(`Internal error`);

        if (!builtinModulesSet.has(filePath)) {
            // TODO: watching files
            watchFile(filePath, () => {
                invalidate();
            });
        }
    }
    return obj;
}

async function parseFileInternal(filePath: string): Promise<FileParseObj> {
    let obj: FileParseObj = {
        filePath,
        fileSize: 0,
        fileImportSpecs: new Set(),

        lastModifiedTime: 0,
        parseError: "",
        readTime: 0,
        parseTime: 0,
    };

    let readTime = Date.now();

    if (!builtinModulesSet.has(filePath)) {
        let stat: { mtimeMs: number, size: number } | undefined;
        try {
            stat = await statFileFromDiskOrEditor(filePath);
        } catch (e) {
            obj.parseError = e.stack;
        }

        if (stat) {
            obj.fileSize = stat.size;
            obj.lastModifiedTime = stat.mtimeMs;
        }

        obj.readTime = Date.now() - readTime;

        if (stat && obj && extensions.some(x => filePath.endsWith(x))) {
            let fileContents = await readFileFromDiskOrEditor(filePath);

            obj.readTime = Date.now() - readTime;

            let parseTime = Date.now();

            let ast: Program | undefined;
            try {
                ast = parse(fileContents, {
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

                obj.parseTime = Date.now() - parseTime;

                for (let importObj of getImports(ast, allNodes, fileContents)) {
                    if (!importObj.unused) {
                        obj.fileImportSpecs.add(importObj.importSpec);
                    }
                }
            }
        }
    }

    return obj;
}

async function getAllFileDependencies(filePath: string, ignorePaths: Set<string>): Promise<{
    results: {
        count: number;
        obj: FileParseObj;
    }[];
    ignorePathsHit: boolean;
}> {

    let results: Map<string, {
        count: number;
        obj: FileParseObj;
    }> = new Map();

    let pendingFiles: string[] = [filePath];

    let ignorePathsHit = false;

    let limitLeft = 10000;
    while (pendingFiles.length > 0) {
        if (limitLeft-- < 0) {
            throw new Error(`Reached file iteration limit while trying to iterate on dependencies of ${filePath}`);
        }

        let filePathProvider = pendingFiles.shift();
        if (!filePathProvider) continue;

        if (ignorePaths.has(filePathProvider)) {
            ignorePathsHit = true;
            continue;
        }

        let obj = results.get(filePathProvider);
        if (obj) {
            obj.count++;
            continue;
        }

        let parseObj = await parseFile(filePathProvider).value;
        results.set(filePathProvider, {
            count: 1,
            obj: parseObj,
        });

        for (let importSpec of parseObj.fileImportSpecs) {
            let fileToAdd = await getResolvedPath(importSpec, filePathProvider);
            if ("result" in fileToAdd) {
                pendingFiles.push(fileToAdd.result);
            }
        }
    }

    return {
        results: Array.from(results.values()),
        ignorePathsHit,
    };
}


onUpdatedAST(async ({ setDecoration, traverse, doc, ast, }) => {
    let allNodes: Node[] = [];

    traverse({
        enter: node => {
            allNodes.push(node);
        }
    });

    let allFiles: Map<string, {
        obj: FileParseObj;
        cyclicCount: number;
        nodes: Set<Node>;
        cyclicWithCurFile: boolean;
        readTime: number;
        parseTime: number;
    }> = new Map();

    let curFilePath = path.resolve(doc.fileName);

    for (let importObj of getImports(ast, allNodes, doc.getText())) {
        if (importObj.unused) {
            setDecoration({
                node: importObj.node,
                after: {
                    contentText: `Unused`,
                    //contentText: resolvedPath,
                    color: `hsl(0, 0%, 75%)`,
                    margin: "0px 0px 0px 8px"
                },
                hoverMessage: `Unused`,
            });
            continue;
        }
        let resolvedPath = await getResolvedPath(importObj.importSpec, doc.fileName);
        if ("error" in resolvedPath) {
            setDecoration({
                node: importObj.node,
                after: {
                    contentText: `Cannot resolve path`,
                    //contentText: resolvedPath,
                    color: `hsl(0, 75%, 75%)`,
                    margin: "0px 0px 0px 8px"
                },
                hoverMessage: `Can't resolve ${importObj.importSpec} in ${doc.fileName}\n${resolvedPath.error}`,
            });
            continue;
        }
        let dependenciesObj = await getAllFileDependencies(resolvedPath.result, new Set([curFilePath]));

        for (let dependency of dependenciesObj.results) {
            let dependObj = allFiles.get(dependency.obj.filePath);
            if (!dependObj) {
                dependObj = {
                    obj: dependency.obj,
                    cyclicCount: dependency.count,
                    nodes: new Set(),
                    cyclicWithCurFile: false,
                    readTime: 0,
                    parseTime: 0,
                };
                allFiles.set(dependency.obj.filePath, dependObj);
            }
            dependObj.nodes.add(importObj.node);
            dependObj.cyclicWithCurFile = dependenciesObj.ignorePathsHit;
            dependObj.readTime += dependObj.readTime;
            dependObj.parseTime += dependObj.parseTime;
        }
    }

    let dependencies = new Set(allFiles.keys());
    let lastDependencies = viewDependencies.get(doc.fileName) || new Set();
    viewDependencies.set(doc.fileName, dependencies);
    for (let dependency of lastDependencies) {
        if (!dependencies.has(dependency)) {
            let set = viewReverseDependencies.get(dependency);
            if (set) {
                set.delete(doc.fileName);
                if (set.size === 0) {
                    viewReverseDependencies.delete(dependency);
                }
            }
        }
    }
    for (let dependency of dependencies) {
        let set = viewReverseDependencies.get(dependency);
        if (!set) {
            set = new Set();
            viewReverseDependencies.set(dependency, set);
        }
        set.add(doc.fileName);
    }

    let nodeCosts: Map<Node, {
        filePaths: Set<string>;
        fullCost: number;
        costWithSharedSplit: number;
        notFoundFiles: Set<string>;
        cyclicCount: number;
        cyclicWithCurFile: boolean;
        readTime: number;
        parseTime: number;
    }> = new Map();

    for (let [filePath, fileObj] of allFiles) {
        for (let node of fileObj.nodes) {
            let costs = nodeCosts.get(node);
            if (!costs) {
                costs = {
                    filePaths: new Set(),
                    fullCost: 0,
                    costWithSharedSplit: 0,
                    notFoundFiles: new Set(),
                    cyclicCount: 0,
                    cyclicWithCurFile: false,
                    readTime: 0,
                    parseTime: 0,
                };
                nodeCosts.set(node, costs);
            }
            costs.filePaths.add(filePath);
            costs.fullCost += fileObj.obj.fileSize;
            if (fileObj.obj.parseError) {
                costs.notFoundFiles.add(fileObj.obj.filePath);
            }
            costs.costWithSharedSplit += fileObj.obj.fileSize / fileObj.nodes.size;
            if (fileObj.cyclicWithCurFile) {
                costs.cyclicWithCurFile = true;
            }
            costs.readTime += fileObj.obj.readTime;
            costs.parseTime += fileObj.obj.parseTime;
        }
    }

    for (let [node, costsObj] of nodeCosts) {
        let color = `hsl(283, 75%, 75%)`;
        let hoverMessage = `${costsObj.filePaths.size} files, ${b(costsObj.fullCost)} size`;

        let message = `${b(costsObj.fullCost)}/${costsObj.filePaths.size}`;
        if (costsObj.costWithSharedSplit !== costsObj.fullCost) {
            hoverMessage += `, ${b(costsObj.costWithSharedSplit)} size when shared dependencies sizes are split between imports`;
            message += ` (${b(costsObj.costWithSharedSplit)})`;
        }
        if (costsObj.notFoundFiles.size > 0) {
            color = `hsl(0, 75%, 75%)`;
            message += `, ${costsObj.notFoundFiles.size} not found`;
            hoverMessage += `, cannot find: ${Array.from(costsObj.notFoundFiles).join(", ")}`;
        }

        if (costsObj.readTime > 1000) {
            message += ` (slow file read, ${costsObj.readTime}ms)`;
        }
        if (costsObj.parseTime > 1000) {
            message += ` (slow file parse, ${costsObj.parseTime}ms)`;
        }
        hoverMessage += `, file read took ${costsObj.readTime}ms`;
        hoverMessage += `, file parse took ${costsObj.parseTime}ms`;

        if (costsObj.cyclicWithCurFile) {
            message += ` + cyclic`;
            hoverMessage += `, this import depends on the this file (a cyclic dependency)`;
        }

        setDecoration({
            node,
            after: {
                contentText: message,
                color,
                margin: "0px 0px 0px 8px",
            },
            hoverMessage,
        });
    }
});
