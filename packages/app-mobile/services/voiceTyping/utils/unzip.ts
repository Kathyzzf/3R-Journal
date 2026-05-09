import { NativeModules } from 'react-native';

interface RNZipArchiveModule {
	unzip(source: string, target: string, charset: string): Promise<void>;
}

const normalizeFilePath = (path: string) => path.startsWith('file://') ? path.slice(7) : path;

export default async (source: string, target: string) => {
	const zipArchive = NativeModules.RNZipArchive as RNZipArchiveModule | undefined;
	if (!zipArchive?.unzip) {
		throw new Error('RNZipArchive native module is not available. Reinstall iOS pods and rebuild the app.');
	}
	await zipArchive.unzip(normalizeFilePath(source), normalizeFilePath(target), 'UTF-8');
};
