import * as vscode from "vscode";
import { Program, Node } from "@typescript-eslint/typescript-estree/dist/ts-estree/ts-estree";
import { AST_NODE_TYPES, parse } from "@typescript-eslint/typescript-estree";
import { EnterExitTraverser } from "./enterExitTraverser";

export function activate(context: vscode.ExtensionContext) {
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

        status.text = `Extension ${sum}ms/${recentRunLength}ms, ${recentRuns.length}, Last ${lastTime}ms`;
        status.show();
    }


    let timeout: NodeJS.Timer | undefined = undefined;
    let updateStatus: "none" | "pending" | "pendingStale" = "none";

    triggerUpdateDecorations();

    function triggerUpdateDecorations() {
        if (updateStatus === "pending") {
            updateStatus = "pendingStale";
            return;
        }
        if (updateStatus === "pendingStale") {
            return;
        }
        updateStatus = "pending";

        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        timeout = setTimeout(async () => {
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) return;
                let languageId = activeEditor.document.languageId;
                if (languageId !== "typescriptreact" && languageId !== "typescript" && languageId !== "javascript" && languageId !== "javascriptreact") return;
                await timeCode(() => updateDecorations(activeEditor));
            } finally {
                let status = updateStatus;
                updateStatus = "none";
                if (status === "pendingStale") {
                    triggerUpdateDecorations();
                }
            }
        }, 500);
    }

    vscode.window.onDidChangeActiveTextEditor(editor => {
        triggerUpdateDecorations();
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === vscode.window.activeTextEditor?.document) {
            triggerUpdateDecorations();
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


let currentDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();

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
            config: {
                // "stop" stops the traverse, calling exit on the remaining entered nodes, but not calling enter on any more nodes
                // "skipSiblings" prevents any more nodes with the same parent (siblings) from being traversed, calling exit on this node,
                //  and then exit on our parent, then continuing traversal.
                // "ignore" ignores the node, still calling exit on it, but not traversing down on it. Siblings, etc are still traversed
                enter: (statement: Node, parent?: Node, property?: string) => "stop" | "skipSiblings" | "ignore" | void,
                exit?: (statement: Node, parent?: Node, property?: string) => void,
            }
        ): void {
            if (callbacksExpired) throw new Error(`Cannot call callback after update callback finishes.`);

            new EnterExitTraverser({
                enter: config.enter,
                exit: config.exit,
            }).traverse(ast);
        }

        await updatedCallback({
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

    for (let [optionsJSON, dec] of currentDecorations) {
        if (!decMap.has(optionsJSON)) {
            editor.setDecorations(dec, []);
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
            doc: vscode.TextDocument,
            setDecoration: (
                decoration: DecorationIntersection
            ) => void,
            traverse: (
                config: {
                    // "stop" stops the traverse, calling exit on the remaining entered nodes, but not calling enter on any more nodes
                    // "skipSiblings" prevents any more nodes with the same parent (siblings) from being traversed, calling exit on this node,
                    //  and then exit on our parent, then continuing traversal.
                    enter: (statement: Node, parent?: Node, property?: string) => "stop" | "skipSiblings" | void,
                    exit?: (statement: Node, parent?: Node, property?: string) => void,
                }
            ) => void
        }
    ): Promise<void> | void
};


import "./decorationSetup";