import { pack as tarStreamPack } from 'tar-stream';
import { resolve } from 'path';
import { Buffer } from 'buffer';

import Logger from '@joplin/utils/Logger';
import { chunkSize } from './constants';
import shim from '@joplin/lib/shim';

const logger = Logger.create('fs-driver-rn');

export interface TarCreateOptions {
	cwd: string;
	file: string;
}

// TODO: Support glob patterns, which are currently supported by the
//       node fsDriver.

const tarCreate = async (options: TarCreateOptions, filePaths: string[]) => {
	// Choose a default cwd if not given
	const cwd = options.cwd ?? shim.fsDriver().getAppDirectoryPath();
	const file = resolve(cwd, options.file);

	const fsDriver = shim.fsDriver();
	if (await fsDriver.exists(file)) {
		throw new Error('Error! Destination already exists');
	}
	await fsDriver.writeFile(file, '', 'base64');

	const pack = tarStreamPack();
	const appendPackDataPromise = (async () => {
		for await (const data of pack) {
			const buff = Buffer.from(data);
			const base64Data = buff.toString('base64');
			await fsDriver.appendFile(file, base64Data, 'base64');
		}
	})();

	const errors: Error[] = [];
	pack.addListener('error', error => {
		logger.error(`Tar error: ${error}`);
		errors.push(error);
	});

	try {
		for (const path of filePaths) {
			const absPath = resolve(cwd, path);
			const stat = await fsDriver.stat(absPath);
			const sizeBytes: number = stat.size;

			let resolveEntry: ()=> void = () => {};
			let rejectEntry: (error: Error)=> void = () => {};
			const entryDonePromise = new Promise<void>((resolve, reject) => {
				resolveEntry = resolve;
				rejectEntry = reject;
			});

			const entry = pack.entry({ name: path, size: sizeBytes }, (error) => {
				if (error) {
					logger.error(`Tar error: ${error}`);
					rejectEntry(error);
				} else {
					resolveEntry();
				}
			});

			const handle = await shim.fsDriver().open(absPath, 'r');

			try {
				let offset = 0;
				let lastOffset = -1;
				while (offset < sizeBytes && offset !== lastOffset) {
					const part = await shim.fsDriver().readFileChunkAsBuffer(handle, chunkSize);
					entry.write(part);

					lastOffset = offset;
					offset += part.byteLength;
				}
				entry.end();
				await entryDonePromise;
			} catch (error) {
				entry.destroy(error as Error);
				throw error;
			} finally {
				await shim.fsDriver().close(handle);
			}
		}

		pack.finalize();
		await appendPackDataPromise;
	} catch (error) {
		pack.destroy(error as Error);
		await appendPackDataPromise.catch(() => {});
		throw error;
	}

	if (errors.length) {
		throw new Error(`tarCreate errors: ${errors.map(e => `Error: ${e}, stack: ${e?.stack}`)}`);
	}
};

export default tarCreate;
