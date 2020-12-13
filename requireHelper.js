const { Server } = require("net");
const { argv, stdout, mainModule } = require("process");

let callbacks = [];
let availableLines = [];
let bufferLine = [];
function flushLine() {
    let buffer = Buffer.concat(bufferLine);
    bufferLine = [];
    let callback = callbacks.shift();
    if (callback) {
        callback(buffer);
        return;
    }
    availableLines.push(buffer);
}
async function getLine() {
    let line = availableLines.shift();
    if (line) {
        return line;
    }
    return new Promise(resolve => callbacks.push(resolve));
}

process.stdin.on("data", data => {
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


(main());
async function main() {
    while (true) {
        let request = JSON.parse((await getLine()).toString());
        try {
            let result = require.resolve(request.id, { paths: [request.path] });
            stdout.write(JSON.stringify({ result, seqNum: request.seqNum }) + "\0");
        } catch (e) {
            stdout.write(JSON.stringify({ error: e.stack, seqNum: request.seqNum }) + "\0");
        }
    }
}