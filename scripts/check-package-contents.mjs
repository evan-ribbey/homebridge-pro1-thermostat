/* global console, process */
// Reads `npm pack --dry-run --json` from stdin and fails unless the tarball
// holds exactly what should ship: every required file and nothing unexpected.
import { readFileSync } from 'node:fs';

const REQUIRED = ['dist/index.js', 'certs/aws-iot-classic-root.pem', 'config.schema.json'];
const ALLOWED = [
  /^dist\/.+\.js$/,
  /^certs\/aws-iot-classic-root\.pem$/,
  /^(config\.schema\.json|package\.json|README\.md|LICENSE|CHANGELOG\.md)$/,
];

const files = JSON.parse(readFileSync(0, 'utf8'))[0].files.map((file) => file.path);
const missing = REQUIRED.filter((path) => !files.includes(path));
const unexpected = files.filter((path) => !ALLOWED.some((pattern) => pattern.test(path)));

if (missing.length > 0) {
  console.error(`Missing from package tarball: ${missing.join(', ')}`);
}
if (unexpected.length > 0) {
  console.error(`Unexpected in package tarball: ${unexpected.join(', ')}`);
}
if (missing.length > 0 || unexpected.length > 0) {
  process.exit(1);
}
console.log(`Package contents OK (${files.length} files).`);
