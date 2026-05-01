/**
 * Test File Bundler
 *
 * Uses esbuild to bundle test files with the runtime,
 * producing a single executable JavaScript string.
 */

import * as esbuild from 'esbuild';
import { resolve } from 'path';
import { readFileSync } from 'fs';

/**
 * Bundle a test file with the Tasto runtime.
 * Resolves @tasto/test imports to our runtime module.
 * Wraps test files in an async function to support top-level await.
 */
export async function bundleTestFile(testFilePath: string): Promise<string> {
  const runtimePath = resolve(__dirname, 'runtime.ts');

  const result = await esbuild.build({
    entryPoints: [testFilePath],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2017',
    platform: 'neutral',
    // Transform async/await to promises for Hermes CDP compatibility
    supported: {
      'async-await': false,
    },
    plugins: [
      {
        name: 'tasto-runtime',
        setup(build) {
          // Redirect @tasto/test imports to our runtime
          build.onResolve({ filter: /^@tasto\/test$/ }, () => ({
            path: runtimePath,
          }));
        },
      },
      {
        name: 'wrap-top-level-await',
        setup(build) {
          // Wrap test files to support top-level await
          build.onLoad({ filter: /\.test\.ts$/ }, async (args) => {
            const contents = readFileSync(args.path, 'utf8');

            // Extract import statements
            const lines = contents.split('\n');
            const imports: string[] = [];
            const code: string[] = [];

            for (const line of lines) {
              if (line.trim().startsWith('import ') || line.trim().startsWith('import{')) {
                imports.push(line);
              } else {
                code.push(line);
              }
            }

            // Wrap non-import code in an async function
            const wrapped = `
              ${imports.join('\n')}
              (async () => {
                ${code.join('\n')}
              })();
            `;
            return {
              contents: wrapped,
              loader: 'ts',
            };
          });
        },
      },
    ],
    // Don't include source maps in the bundled output
    sourcemap: false,
    // Minify for smaller payload (optional, can be disabled for debugging)
    minify: false,
    // Keep names for better error messages
    keepNames: true,
  });

  if (result.errors.length > 0) {
    const errorMessages = result.errors.map((e) => e.text).join('\n');
    throw new Error(`Bundle failed:\n${errorMessages}`);
  }

  const bundledCode = result.outputFiles?.[0]?.text;
  if (!bundledCode) {
    throw new Error('No output from bundler');
  }

  return bundledCode;
}

/**
 * Extract test names from bundled code for progress tracking.
 */
export function extractTestNames(code: string): string[] {
  const testNames: string[] = [];
  const regex = /runTest\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    testNames.push(match[1]);
  }
  return testNames;
}
