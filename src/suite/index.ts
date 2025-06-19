import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true
  });

  const testsRoot = path.resolve(__dirname, '..');

  try {
    const files: string[] = await glob('**/*.test.js', { cwd: testsRoot });

    files.forEach((file: string) => {
      mocha.addFile(path.resolve(testsRoot, file));
    });

    await new Promise<void>((resolve, reject) => {
      mocha.run(failures => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    });

  } catch (err) {
    console.error('Test run failed:', err);
    throw err;
  }
}
