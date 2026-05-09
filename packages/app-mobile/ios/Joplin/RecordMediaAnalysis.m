#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <Speech/Speech.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>

@interface RecordMediaAnalysis : NSObject <RCTBridgeModule>
@end

@implementation RecordMediaAnalysis

RCT_EXPORT_MODULE();

- (NSString *)normalizedPath:(NSString *)path
{
	return [path hasPrefix:@"file://"] ? [path substringFromIndex:7] : path;
}

- (NSArray *)serializedSegments:(SFTranscription *)transcription
{
	NSMutableArray *segments = [NSMutableArray array];
	for (SFTranscriptionSegment *segment in transcription.segments) {
		[segments addObject:@{
			@"text": segment.substring ?: @"",
			@"timestampMs": @((NSInteger)llround(segment.timestamp * 1000)),
			@"durationMs": @((NSInteger)llround(segment.duration * 1000)),
		}];
	}
	return segments;
}

- (void)transcribeAudioAtPath:(NSString *)path
			  includeSegments:(BOOL)includeSegments
					 resolver:(RCTPromiseResolveBlock)resolve
					 rejecter:(RCTPromiseRejectBlock)reject
{
	[SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
		if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
			reject(@"record_media_speech_auth", @"Speech recognition permission was not granted", nil);
			return;
		}

		NSLocale *locale = [NSLocale currentLocale];
		SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
		if (recognizer == nil || !recognizer.available) {
			reject(@"record_media_speech_unavailable", @"Speech recognizer is not available", nil);
			return;
		}

		NSURL *url = [NSURL fileURLWithPath:[self normalizedPath:path]];
		SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
		request.shouldReportPartialResults = NO;
		__block BOOL completed = NO;
		[recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
			if (completed) return;
			if (error != nil) {
				completed = YES;
				reject(@"record_media_speech_failed", @"Could not transcribe audio", error);
				return;
			}
			if (result.isFinal) {
				completed = YES;
				resolve(includeSegments ? [self serializedSegments:result.bestTranscription] : result.bestTranscription.formattedString ?: @"");
			}
		}];
	}];
}

RCT_EXPORT_METHOD(extractAudioText:(NSString *)audioPath
				  resolver:(RCTPromiseResolveBlock)resolve
				  rejecter:(RCTPromiseRejectBlock)reject)
{
	[self transcribeAudioAtPath:audioPath includeSegments:NO resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(extractAudioSegments:(NSString *)audioPath
				  resolver:(RCTPromiseResolveBlock)resolve
				  rejecter:(RCTPromiseRejectBlock)reject)
{
	[self transcribeAudioAtPath:audioPath includeSegments:YES resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(extractImageText:(NSString *)imagePath
				  resolver:(RCTPromiseResolveBlock)resolve
				  rejecter:(RCTPromiseRejectBlock)reject)
{
	dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
		NSString *normalizedImagePath = [self normalizedPath:imagePath];
		UIImage *image = [UIImage imageWithContentsOfFile:normalizedImagePath];
		if (image == nil || image.CGImage == nil) {
			reject(@"record_media_image_unavailable", @"Could not load image for OCR", nil);
			return;
		}

		VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
		request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
		request.usesLanguageCorrection = YES;
		if (@available(iOS 16.0, *)) {
			request.automaticallyDetectsLanguage = YES;
		}

		VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image.CGImage options:@{}];
		NSError *error = nil;
		[handler performRequests:@[request] error:&error];
		if (error != nil) {
			reject(@"record_media_image_ocr_failed", @"Could not extract image text", error);
			return;
		}

		NSMutableArray<NSString *> *lines = [NSMutableArray array];
		for (VNRecognizedTextObservation *observation in request.results) {
			VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
			if (candidate.string.length > 0) {
				[lines addObject:candidate.string];
			}
		}
		resolve([lines componentsJoinedByString:@"\n"]);
	});
}

RCT_EXPORT_METHOD(extractVideoAudioText:(NSString *)videoPath
				  resolver:(RCTPromiseResolveBlock)resolve
				  rejecter:(RCTPromiseRejectBlock)reject)
{
	dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
		NSString *normalizedVideoPath = [self normalizedPath:videoPath];
		AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:normalizedVideoPath] options:nil];
		NSArray *audioTracks = [asset tracksWithMediaType:AVMediaTypeAudio];
		if (audioTracks.count == 0) {
			resolve(@"");
			return;
		}

		NSString *outputPath = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"3r-video-audio-%@.m4a", [[NSUUID UUID] UUIDString]]];
		NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
		AVAssetExportSession *exportSession = [[AVAssetExportSession alloc] initWithAsset:asset presetName:AVAssetExportPresetAppleM4A];
		if (exportSession == nil) {
			reject(@"record_media_audio_export_unavailable", @"Could not create audio export session", nil);
			return;
		}
		exportSession.outputURL = outputURL;
		exportSession.outputFileType = AVFileTypeAppleM4A;
		[exportSession exportAsynchronouslyWithCompletionHandler:^{
			if (exportSession.status != AVAssetExportSessionStatusCompleted) {
				reject(@"record_media_audio_export_failed", @"Could not export video audio", exportSession.error);
				return;
			}
			[self transcribeAudioAtPath:outputPath includeSegments:NO resolver:^(id result) {
				[[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
				resolve(result);
			} rejecter:^(NSString *code, NSString *message, NSError *error) {
				[[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
				reject(code, message, error);
			}];
		}];
	});
}

RCT_EXPORT_METHOD(extractVideoAudioSegments:(NSString *)videoPath
				  resolver:(RCTPromiseResolveBlock)resolve
				  rejecter:(RCTPromiseRejectBlock)reject)
{
	dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
		NSString *normalizedVideoPath = [self normalizedPath:videoPath];
		AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:normalizedVideoPath] options:nil];
		NSArray *audioTracks = [asset tracksWithMediaType:AVMediaTypeAudio];
		if (audioTracks.count == 0) {
			resolve(@[]);
			return;
		}

		NSString *outputPath = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"3r-video-audio-%@.m4a", [[NSUUID UUID] UUIDString]]];
		NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
		AVAssetExportSession *exportSession = [[AVAssetExportSession alloc] initWithAsset:asset presetName:AVAssetExportPresetAppleM4A];
		if (exportSession == nil) {
			reject(@"record_media_audio_export_unavailable", @"Could not create audio export session", nil);
			return;
		}
		exportSession.outputURL = outputURL;
		exportSession.outputFileType = AVFileTypeAppleM4A;
		[exportSession exportAsynchronouslyWithCompletionHandler:^{
			if (exportSession.status != AVAssetExportSessionStatusCompleted) {
				reject(@"record_media_audio_export_failed", @"Could not export video audio", exportSession.error);
				return;
			}
			[self transcribeAudioAtPath:outputPath includeSegments:YES resolver:^(id result) {
				[[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
				resolve(result);
			} rejecter:^(NSString *code, NSString *message, NSError *error) {
				[[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
				reject(code, message, error);
			}];
		}];
	});
}

RCT_EXPORT_METHOD(extractVideoFrames:(NSString *)videoPath
				  outputDir:(NSString *)outputDir
				  count:(nonnull NSNumber *)count
				  resolver:(RCTPromiseResolveBlock)resolve
				  rejecter:(RCTPromiseRejectBlock)reject)
{
	dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
		NSString *normalizedVideoPath = [self normalizedPath:videoPath];
		NSString *normalizedOutputDir = [self normalizedPath:outputDir];
		NSError *directoryError = nil;
		[[NSFileManager defaultManager] createDirectoryAtPath:normalizedOutputDir withIntermediateDirectories:YES attributes:nil error:&directoryError];
		if (directoryError != nil) {
			reject(@"record_media_frame_dir", @"Could not create frame output directory", directoryError);
			return;
		}

		AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:normalizedVideoPath] options:nil];
		AVAssetImageGenerator *generator = [[AVAssetImageGenerator alloc] initWithAsset:asset];
		generator.appliesPreferredTrackTransform = YES;
		generator.maximumSize = CGSizeMake(960, 960);
		generator.requestedTimeToleranceBefore = kCMTimeZero;
		generator.requestedTimeToleranceAfter = kCMTimeZero;
		Float64 durationSeconds = CMTimeGetSeconds(asset.duration);
		if (!isfinite(durationSeconds) || durationSeconds <= 0) {
			durationSeconds = 1;
		}

		NSInteger frameCount = MAX(1, MIN([count integerValue], 6));
		NSMutableArray<NSDictionary *> *frames = [NSMutableArray array];
		for (NSInteger index = 0; index < frameCount; index++) {
			Float64 seconds = durationSeconds * (index + 1) / (frameCount + 1);
			CMTime time = CMTimeMakeWithSeconds(seconds, 600);
			NSError *imageError = nil;
			CMTime actualTime = kCMTimeZero;
			CGImageRef imageRef = [generator copyCGImageAtTime:time actualTime:&actualTime error:&imageError];
			if (imageRef == nil) {
				continue;
			}

			UIImage *image = [UIImage imageWithCGImage:imageRef];
			CGImageRelease(imageRef);
			NSData *data = UIImageJPEGRepresentation(image, 0.72);
			if (data == nil) {
				continue;
			}

			NSString *path = [normalizedOutputDir stringByAppendingPathComponent:[NSString stringWithFormat:@"frame-%ld.jpg", (long)index + 1]];
			if ([data writeToFile:path atomically:YES]) {
				Float64 actualSeconds = CMTimeGetSeconds(actualTime);
				if (!isfinite(actualSeconds)) {
					actualSeconds = seconds;
				}
				[frames addObject:@{
					@"path": path,
					@"timestampMs": @((NSInteger)llround(actualSeconds * 1000)),
				}];
			}
		}

		resolve(frames);
	});
}

@end
