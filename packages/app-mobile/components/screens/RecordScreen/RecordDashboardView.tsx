import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ThemeStyle } from '../../global-style';
import createStyles from './styles';
import RecordAnalysisService, { RecordDashboardStats } from '../../../services/records/RecordAnalysisService';
import Logger from '@joplin/utils/Logger';

const logger = Logger.create('RecordDashboardView');

interface Props {
	theme: ThemeStyle;
}

const ProgressBar: React.FC<{ label: string; value: number; theme: ThemeStyle }> = ({ label, value, theme }) => {
	const styles = useMemo(() => createStyles(theme), [theme]);
	return (
		<View style={styles.dashboardProgressItem}>
			<Text style={styles.dashboardProgressLabel}>{label}</Text>
			<View style={styles.dashboardProgressTrack}>
				<View style={[styles.dashboardProgressFill, { width: `${Math.round(value * 100)}%` }]} />
			</View>
		</View>
	);
};

const RecordDashboardView: React.FC<Props> = ({ theme }) => {
	const styles = useMemo(() => createStyles(theme), [theme]);
	const [stats, setStats] = useState<RecordDashboardStats | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setStats(await RecordAnalysisService.dashboardStats());
		} catch (error) {
			logger.error('Failed to load dashboard:', error);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (loading || !stats) {
		return <View style={styles.loadingContainer}><ActivityIndicator size="large" /></View>;
	}

	const tiles = [
		{ label: '本周条目', value: stats.weeklyRecords },
		{ label: '记录', value: stats.totalRecords },
		{ label: '复盘', value: stats.reflections },
		{ label: '精进', value: stats.flashcards },
		{ label: '分享', value: stats.shares },
		{ label: '被关注', value: stats.followers },
	];

	return (
		<ScrollView style={styles.analysisContainer} showsVerticalScrollIndicator={false}>
			<View style={styles.dashboardHeader}>
				<View style={styles.dashboardIcon}>
					<View style={styles.dashboardIconBarTall} />
					<View style={styles.dashboardIconBar} />
					<View style={styles.dashboardIconDot} />
				</View>
				<View>
					<Text style={styles.analysisTitle}>3R Dashboard</Text>
					<Text style={styles.analysisMeta}>记录、复盘、精进、分享的周进展</Text>
				</View>
			</View>

			<View style={styles.dashboardGrid}>
				{tiles.map(tile => (
					<View key={tile.label} style={styles.dashboardTile}>
						<Text style={styles.dashboardTileValue}>{tile.value}</Text>
						<Text style={styles.dashboardTileLabel}>{tile.label}</Text>
					</View>
				))}
			</View>

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>进展</Text>
				<ProgressBar label="记录" value={stats.progress.record} theme={theme} />
				<ProgressBar label="复盘" value={stats.progress.reflect} theme={theme} />
				<ProgressBar label="精进" value={stats.progress.refine} theme={theme} />
				<ProgressBar label="分享" value={stats.progress.share} theme={theme} />
			</View>

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>主题词云</Text>
				<View style={styles.wordCloud}>
					{stats.wordCloud.map(item => (
						<Text
							key={item.word}
							style={[styles.wordCloudItem, { fontSize: Math.min(24, 12 + item.weight) }]}
						>
							{item.word}
						</Text>
					))}
				</View>
			</View>

			<TouchableOpacity style={styles.primaryActionButton} onPress={load}>
				<Text style={styles.primaryActionButtonText}>刷新看板</Text>
			</TouchableOpacity>
		</ScrollView>
	);
};

export default RecordDashboardView;
