import * as vscode from "vscode";
import { Program, Node } from "@typescript-eslint/typescript-estree/dist/ts-estree/ts-estree";
import { AST_NODE_TYPES, parse } from "@typescript-eslint/typescript-estree";
import { EnterExitTraverser } from "./enterExitTraverser";
import * as fse from "fs-extra";

let status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
let recentRunLength = 10 * 1000;
let recentRuns: { start: number; end: number }[] = [];
async function timeCode(code: () => Promise<void>) {
    let runStart = Date.now();
    try {
        await code();
    } catch (e) {
        (vscode.window.showInformationMessage(`Parse error ${e.stack}!`));
    } finally {
        let runEnd = Date.now();
        recentRuns.push({ start: runStart, end: runEnd });
    }

    updateUsageFraction();
}
function updateUsageFraction() {
    let sum = 0;
    let threshold = Date.now() - recentRunLength;
    for (let i = recentRuns.length - 1; i >= 0; i--) {
        let run = recentRuns[i];
        if (run.start < threshold) {
            recentRuns.splice(i);
        }
        let time = run.end - run.start;
        sum += time;
    }
    let usageFrac = sum / recentRunLength;

    let lastTime = 0;
    if (recentRuns.length > 0) {
        lastTime = recentRuns[recentRuns.length - 1].end - recentRuns[recentRuns.length - 1].start;
    }

    status.text = `Require-size ${sum}ms/${recentRunLength}ms, ${recentRuns.length}, Last ${lastTime}ms`;
    status.show();
}

export function activate(context: vscode.ExtensionContext) {
    for (let editor of vscode.window.visibleTextEditors) {
        triggerUpdateDecorations(editor)
    }

    vscode.window.onDidChangeActiveTextEditor(editor => {
        editor && triggerUpdateDecorations(editor);
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        let editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor?.document) {
            triggerUpdateDecorations(editor);
        }
    }, null, context.subscriptions);

    context.subscriptions.push(status);
}

let onUpdatedCallbacks: UpdatedAST[] = [];
export function onUpdatedAST(updatedCallback: UpdatedAST) {
    onUpdatedCallbacks.push(updatedCallback);
}


type DecorationIntersection = (
    Omit<vscode.DecorationRenderOptions & vscode.DecorationInstanceRenderOptions, "range">
    & ({ range: vscode.Range } | { node: Node })
    & {
        hoverMessage?: vscode.DecorationOptions["hoverMessage"];
    }
);
function splitRenderOptions(intersection: DecorationIntersection): {
    options: vscode.DecorationRenderOptions;
    instance: vscode.DecorationInstanceRenderOptions;
    range: vscode.Range;
    hoverMessage?: vscode.DecorationOptions["hoverMessage"];
} {
    if ("node" in intersection) {
        let { node, ...remaining } = intersection;
        let { start, end } = node.loc;
        intersection = Object.assign(remaining, { range: new vscode.Range(start.line - 1, start.column, end.line - 1, end.column) });
    }
    let { light, dark, before, after, ...remaining } = intersection;

    return {
        options: remaining,
        instance: {
            light,
            dark,
            before,
            after
        },
        range: intersection.range,
        hoverMessage: intersection.hoverMessage,
    };
}


let editorUpdates: Map<string, { timeout: NodeJS.Timer | undefined, updateStatus: "none" | "pending" | "pendingStale" }> = new Map();
function triggerUpdateDecorations(editor: vscode.TextEditor) {
    let updates = editorUpdates.get(editor.document.fileName);
    if (!updates) {
        updates = { timeout: undefined, updateStatus: "none" };
        editorUpdates.set(editor.document.fileName, updates);
    }

    // Restart while the user is typing
    if (updates.timeout) {
        clearTimeout(updates.timeout);
        updates.timeout = undefined;
    } else {
        if (updates.updateStatus === "pending") {
            updates.updateStatus = "pendingStale";
            return;
        }
        if (updates.updateStatus === "pendingStale") {
            return;
        }
        updates.updateStatus = "pending";
    }

    updates.timeout = setTimeout(async () => {
        if (!updates) return;
        updates.timeout = undefined;
        try {
            let languageId = editor.document.languageId;
            if (languageId !== "typescriptreact" && languageId !== "typescript" && languageId !== "javascript" && languageId !== "javascriptreact") return;

            onEditorChange(editor.document.fileName, editor.document.getText());

            await timeCode(() => updateDecorations(editor));
        } finally {
            let status = updates.updateStatus;
            updates.updateStatus = "none";
            if (status === "pendingStale") {
                triggerUpdateDecorations(editor);
            }
        }
    }, 500);
}



let fileWatches: Map<string, Set<(dateModified: number) => void>> = new Map();
let editorFileChanges: Map<string, { contents: string, dateModified: number }> = new Map();


// Both watches the file on disk, AND when the file is changed (but unsaved) in the editor
export function watchFile(
    filePath: string,
    onFileChanged: (dateModified: number) => void,
) {
    let watches = fileWatches.get(filePath);
    if (!watches) {
        watches = new Set();
        fileWatches.set(filePath, watches);
    }
    watches.add(onFileChanged);
}
// Reads the latest modified version, whether this is from the disk or editor.
export async function statFileFromDiskOrEditor(
    filePath: string
): Promise<{
    mtimeMs: number;
    size: number;
    inEditor?: boolean;
    contents?: string;
}> {
    let stat = await fse.stat(filePath);
    let editorChanges = editorFileChanges.get(filePath);
    if (editorChanges && editorChanges.dateModified > stat.mtimeMs) {
        return {
            mtimeMs: editorChanges.dateModified,
            size: editorChanges.contents.length,
            inEditor: true,
            contents: editorChanges.contents,
        };
    }
    return stat;
}
export async function readFileFromDiskOrEditor(
    filePath: string
): Promise<string> {
    let stat = await statFileFromDiskOrEditor(filePath);
    if (stat.contents !== undefined) return stat.contents;
    return (await fse.readFile(filePath)).toString();
}
function onEditorChange(filePath: string, contents: string) {
    let dateModified = Date.now();
    editorFileChanges.set(filePath, { contents, dateModified });
    let watches = fileWatches.get(filePath);
    if (watches) {
        for (let watch of watches) {
            watch(dateModified);
        }
    }
}

export function triggerDecorationChange(filePath: string) {
    for (let textEditor of vscode.window.visibleTextEditors) {
        if (textEditor.document.fileName === filePath) {
            updateDecorations(textEditor).catch(e => {
                (vscode.window.showInformationMessage(`Parse error ${e.stack}!`));
            });
        }
    }
}


let currentDecorationsByFile: Map<string, Map<string, vscode.TextEditorDecorationType>> = new Map();
export async function updateDecorations(
    editor: vscode.TextEditor,
) {
    let doc = editor.document;

    let ast = parse(doc.getText(), {
        module: true,
        ts: true,
        jsx: true,
        next: true,
        loc: true,
        ranges: true,
        raw: true,
    });


    let decorations: DecorationIntersection[] = [];

    for (let updatedCallback of onUpdatedCallbacks) {
        let callbacksExpired = false;
        function setDecoration(
            decoration: DecorationIntersection
        ) {
            // TODO: Add support for this, so they can asynchronously trigger updates, via info from a remote source
            //  (although... the callback is async, so usually they can get the data before the callback ends. This is mostly
            //  so you can watch a remote value and continuously update the the UI. WHICH, also really requires the ability to remove
            //  decorations, or even better to explicitly update them (which should be more efficient anyway)).
            if (callbacksExpired) throw new Error(`Cannot call callback after update callback finishes.`);

            decorations.push(decoration);
        }
        function traverse(
            config: Parameters<Parameters<UpdatedAST>[0]["traverse"]>[0]
        ): void {
            if (callbacksExpired) throw new Error(`Cannot call callback after update callback finishes.`);

            new EnterExitTraverser({
                enter: config.enter,
                exit: config.exit,
            }).traverse(ast);
        }

        await updatedCallback({
            editor,
            doc,
            ast,
            setDecoration,
            traverse
        });
        callbacksExpired = true;
    }

    let decMap: Map<string, {
        options: vscode.DecorationRenderOptions;
        instances: vscode.DecorationOptions[];
    }> = new Map();

    for (let dec of decorations) {
        let { options, instance, range, hoverMessage } = splitRenderOptions(dec);
        let optionsJSON = JSON.stringify(options);
        let decObj = decMap.get(optionsJSON);
        if (!decObj) {
            decObj = {
                options,
                instances: []
            };
            decMap.set(optionsJSON, decObj);
        }
        decObj.instances.push({
            renderOptions: instance,
            range,
            hoverMessage: hoverMessage,
        });
    }

    let currentDecorations = currentDecorationsByFile.get(editor.document.fileName);
    if (!currentDecorations) {
        currentDecorations = new Map();
        currentDecorationsByFile.set(editor.document.fileName, currentDecorations);
    }

    for (let [optionsJSON, dec] of currentDecorations) {
        if (!decMap.has(optionsJSON)) {
            editor.setDecorations(dec, []);
            dec.dispose();
            currentDecorations.delete(optionsJSON);
        }
    }

    for (let [optionsJSON, decObj] of decMap) {
        let dec = currentDecorations.get(optionsJSON);
        if (!dec) {
            dec = vscode.window.createTextEditorDecorationType(decObj.options);
            currentDecorations.set(optionsJSON, dec);
        }
        editor.setDecorations(dec, decObj.instances);
    }
}

export type UpdatedAST = {
    (
        config: {
            ast: Program,
            editor: vscode.TextEditor,
            doc: vscode.TextDocument,
            setDecoration: (
                decoration: DecorationIntersection
            ) => void,
            traverse: (
                config: {
                    // "stop" stops the traverse, calling exit on the remaining entered nodes, but not calling enter on any more nodes
                    // "skipSiblings" prevents any more nodes with the same parent (siblings) from being traversed, calling exit on this node,
                    //  and then exit on our parent, then continuing traversal.
                    // "ignore" ignores the node, still calling exit on it, but not traversing down on it. Siblings, etc are still traversed
                    enter: (statement: Node, parent?: Node, property?: string) => "stop" | "skipSiblings" | "ignore" | void,
                    exit?: (statement: Node, parent?: Node, property?: string) => void,
                }
            ) => void
        }
    ): Promise<void> | void
};


import "./decorationSetup";