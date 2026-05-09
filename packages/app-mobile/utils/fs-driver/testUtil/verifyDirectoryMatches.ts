
import shim from '@joplin/lib/shim';
import { basename, join } from 'path';

const verifyDirectoryMatches = async (baseDir: string, fileContents: Record<string, string>) => {
	const expectedPaths = new Set(Object.keys(fileContents));
	for (const path in fileContents) {
		const fileContent = await shim.fsDriver().readFile(join(baseDir, path), 'utf8');
		const expectedContent = fileContents[path];
		if (fileContent !== fileContents[path]) {
			throw new Error(`File ${path} content mismatch. Was ${JSON.stringify(fileContent)}, expected ${JSON.stringify(expectedContent)}.`);
		}
	}

	const dirStats = await shim.fsDriver().readDirStats(baseDir, { recursive: true });
	const baseName = basename(baseDir);
	for (const stat of dirStats) {
		const pathParts = stat.path.split('/');
		const pathCandidates = [
			stat.path,
			stat.path.startsWith(`${baseName}/`) ? stat.path.slice(baseName.length + 1) : '',
			...pathParts.map((_part, index) => pathParts.slice(index).join('/')),
		].filter(Boolean);
		if (!stat.isDirectory() && !pathCandidates.some(path => expectedPaths.has(path))) {
			throw new Error(`Unexpected file with path ${stat.path} found.`);
		}
	}
};

export default verifyDirectoryMatches;
