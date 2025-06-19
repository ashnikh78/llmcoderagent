"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const path = require("path");
const Mocha = require("mocha");
const glob = require("glob");
function run() {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true
    });
    const testsRoot = path.resolve(__dirname);
    return new Promise((resolve, reject) => {
        glob('**/*.test.js', { cwd: testsRoot }, (err, files) => {
            if (err) {
                return reject(err);
            }
            files.forEach(file => mocha.addFile(path.resolve(testsRoot, file)));
            try {
                mocha.run(failures => {
                    if (failures > 0) {
                        reject(new Error(`${failures} test(s) failed.`));
                    }
                    else {
                        resolve();
                    }
                });
            }
            catch (err) {
                reject(err);
            }
        });
    });
}
