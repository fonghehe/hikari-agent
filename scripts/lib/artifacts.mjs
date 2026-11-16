import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const artifactsRoot = path.join(repositoryRoot, '.artifacts');
export const testResults = path.join(artifactsRoot, 'test-results');
export const desktopStage = path.join(artifactsRoot, 'package/desktop');
export const desktopRelease = path.join(artifactsRoot, 'releases/desktop');
export const vscodeRelease = path.join(artifactsRoot, 'releases/vscode');
