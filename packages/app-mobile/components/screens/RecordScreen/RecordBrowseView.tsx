import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, FlatList, ActivityIndicator, Alert } from 'react-native';
import { Dispatch } from 'redux';
import createStyles from './styles';
import { ThemeStyle } from '../../global-style';
import RecordCard from './RecordCard';
import RecordService, { RecordWithNote } from '../../../services/records/RecordService';
import RecordSearchService, { SearchResult } from '../../../services/records/RecordSearchService';
import Logger from '@joplin/utils/Logger';
import { IconButton } from 'react-native-paper';
import Resource from '@joplin/lib/models/Resource';
import { ResourceEntity } from '@joplin/lib/services/database/types';
import showResource from '../../../commands/util/showResource';
import RecordAnalysisService from '../../../services/records/RecordAnalysisService';

const logger = Logger.create('RecordBrowseView');

interface Props {
	theme: ThemeStyle;
	dispatch: Dispatch;
	onOpenRecord?: (recordId: string)=> void;
}

const RecordBrowseView: React.FC<Props> = ({ theme, dispatch, onOpenRecord }) => {
	const styles = createStyles(theme);
	const [query, setQuery] = useState('');
	const [records, setRecords] = useState<RecordWithNote[]>([]);
	const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
	const [videoResources, setVideoResources] = useState<Record<string, ResourceEntity[]>>({});
	const [loading, setLoading] = useState(true);
	const [searching, setSearching] = useState(false);

	const isSearching = query.trim().length > 0;

	// Load all records
	const loadRecords = useCallback(async () => {
		setLoading(true);
		try {
			const results = await RecordService.listRecords({ limit: 100 });
			setRecords(results);
		} catch (error) {
			logger.error('Failed to load records:', error);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadRecords();
	}, [loadRecords]);

	// Search with debounce
	useEffect(() => {
		if (!isSearching) {
			setSearchResults([]);
			return () => {};
		}

		const timer = setTimeout(async () => {
			setSearching(true);
			try {
				const results = await RecordSearchService.search(query.trim());
				setSearchResults(results);
			} catch (error) {
				logger.error('Search failed:', error);
			} finally {
				setSearching(false);
			}
		}, 300);

		return () => clearTimeout(timer);
	}, [query, isSearching]);

	const handleRecordPress = useCallback((recordId: string, noteId: string) => {
		if (onOpenRecord) {
			onOpenRecord(recordId);
			return;
		}
		dispatch({
			type: 'NAV_GO',
			routeName: 'Note',
			noteId,
		});
	}, [dispatch, onOpenRecord]);

	const loadVideoResources = useCallback(async (recordIds: string[]) => {
		const uniqueIds = Array.from(new Set(recordIds.filter(Boolean)));
		const entries = await Promise.all(uniqueIds.map(async recordId => {
			return [recordId, await RecordService.linkedVideoResources(recordId)] as const;
		}));
		setVideoResources(Object.fromEntries(entries));
	}, []);

	useEffect(() => {
		if (isSearching) return;
		void loadVideoResources(records.map(item => item.record.id));
	}, [isSearching, loadVideoResources, records]);

	useEffect(() => {
		if (!isSearching) return;
		void loadVideoResources(searchResults.map(item => item.recordId));
	}, [isSearching, loadVideoResources, searchResults]);

	const replayVideo = useCallback(async (recordId: string) => {
		const resource = videoResources[recordId]?.[0];
		if (!resource) {
			Alert.alert('没有可播放视频', '这条记录没有找到已上传的视频资源。');
			return;
		}
		try {
			await Resource.requireIsReady(resource);
			await showResource(resource);
		} catch (error) {
			logger.error('Failed to replay video:', error);
			Alert.alert('视频播放失败', `${error}`);
		}
	}, [videoResources]);

	const clearSearch = useCallback(() => {
		setQuery('');
	}, []);

	const triggerReflect = useCallback(async (recordId: string) => {
		try {
			await RecordAnalysisService.triggerManualReflect(recordId);
			Alert.alert('已加入 Reflect 队列', '正在后台处理，稍后可在 Reflect 页面查看。');
		} catch (error) {
			logger.error('Failed to trigger manual reflect:', error);
			Alert.alert('触发 Reflect 失败', `${error}`);
		}
	}, []);

	const renderSearchItem = useCallback(({ item }: { item: SearchResult }) => (
		<RecordCard
			theme={theme}
			title={item.title}
			snippet={item.snippet}
			entryType={item.entryType}
			tags={item.tags}
			updatedTime={item.updatedTime}
			onPress={() => handleRecordPress(item.recordId, item.noteId)}
			onReplayPress={videoResources[item.recordId]?.length ? () => void replayVideo(item.recordId) : undefined}
			onReflectPress={() => void triggerReflect(item.recordId)}
		/>
	), [theme, handleRecordPress, replayVideo, videoResources, triggerReflect]);

	const renderRecordItem = useCallback(({ item }: { item: RecordWithNote }) => {
		const snippet = item.note.body?.substring(0, 100) || '';
		return (
			<RecordCard
				theme={theme}
				title={item.note.title || ''}
				snippet={snippet}
				entryType={item.record.entry_type}
				tags={item.tags}
				updatedTime={item.note.user_updated_time || item.record.updated_time}
				onPress={() => handleRecordPress(item.record.id, item.note.id)}
				onReplayPress={videoResources[item.record.id]?.length ? () => void replayVideo(item.record.id) : undefined}
				onReflectPress={() => void triggerReflect(item.record.id)}
			/>
		);
	}, [theme, handleRecordPress, replayVideo, videoResources, triggerReflect]);

	const renderEmpty = () => (
		<View style={styles.emptyState}>
			<Text style={styles.emptyStateIcon}>📋</Text>
			<Text style={styles.emptyStateText}>
				{isSearching ? '未找到匹配的记录' : '还没有记录，回到 Record 开始一条 3R Journal'}
			</Text>
		</View>
	);

	return (
		<View style={styles.container}>
			{/* Search bar */}
			<View style={styles.searchBar}>
				<Text style={{ fontSize: 18, color: theme.colorFaded }}>🔍</Text>
				<TextInput
					style={styles.searchInput}
					value={query}
					onChangeText={setQuery}
					placeholder="搜索记录..."
					placeholderTextColor={theme.colorFaded}
					selectionColor={theme.textSelectionColor}
					cursorColor={theme.textSelectionColor}
					keyboardAppearance={theme.keyboardAppearance}
					returnKeyType="search"
					autoCapitalize="none"
				/>
				{query.length > 0 && (
					<IconButton
						icon="close-circle"
						size={18}
						onPress={clearSearch}
						iconColor={theme.colorFaded}
					/>
				)}
				{searching && <ActivityIndicator size="small" />}
			</View>

			{/* Results */}
			{loading ? (
				<View style={styles.loadingContainer}>
					<ActivityIndicator size="large" />
				</View>
			) : isSearching ? (
				<FlatList
					data={searchResults}
					renderItem={renderSearchItem}
					keyExtractor={item => item.recordId}
					ListEmptyComponent={renderEmpty}
					showsVerticalScrollIndicator={false}
				/>
			) : (
				<FlatList
					data={records}
					renderItem={renderRecordItem}
					keyExtractor={item => item.record.id}
					ListEmptyComponent={renderEmpty}
					showsVerticalScrollIndicator={false}
					onRefresh={loadRecords}
					refreshing={loading}
				/>
			)}
		</View>
	);
};

export default RecordBrowseView;
