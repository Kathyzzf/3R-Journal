import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View, Text, TouchableOpacity } from 'react-native';
import { connect } from 'react-redux';
import { Dispatch } from 'redux';
import ScreenHeader from '../../ScreenHeader';
import { themeStyle, ThemeStyle } from '../../global-style';
import { AppState } from '../../../utils/types';
import RecordCreateView from './RecordCreateView';
import RecordReflectView from './RecordReflectView';
import RecordRefineView from './RecordRefineView';
import RecordService, { RecordWithNote } from '../../../services/records/RecordService';
import RecordAnalysisService from '../../../services/records/RecordAnalysisService';
import createStyles from './styles';
import { _ } from '@joplin/lib/locale';

interface Props {
	themeId: number;
	dispatch: Dispatch;
}

interface RecordDetailProps {
	theme: ThemeStyle;
	recordId: string;
	dispatch: Dispatch;
	onReflectComplete?: ()=> void;
}

const RecordDetailRecordView: React.FC<RecordDetailProps> = ({ theme, recordId, dispatch, onReflectComplete }) => {
	const styles = useMemo(() => createStyles(theme), [theme]);
	const [record, setRecord] = useState<RecordWithNote | null>(null);
	const [loading, setLoading] = useState(true);
	const [processing, setProcessing] = useState(false);
	const [checkingLlm, setCheckingLlm] = useState(false);

	useEffect(() => {
		const load = async () => {
			setLoading(true);
			try {
				setRecord(await RecordService.getRecord(recordId));
			} finally {
				setLoading(false);
			}
		};
		void load();
	}, [recordId]);

	const openNote = useCallback(() => {
		if (!record) return;
		dispatch({
			type: 'NAV_GO',
			routeName: 'Note',
			noteId: record.note.id,
		});
	}, [dispatch, record]);

	const runReflectNow = useCallback(async () => {
		if (processing) return;
		setProcessing(true);
		try {
			await RecordAnalysisService.runRecordPipelineNow(recordId);
			setRecord(await RecordService.getRecord(recordId));
			onReflectComplete?.();
			Alert.alert(_('Reflect complete'), _('The reflection summary and refinement suggestions have been generated.'));
		} catch (error) {
			Alert.alert(_('Reflect failed'), `${error}`);
		} finally {
			setProcessing(false);
		}
	}, [recordId, processing, onReflectComplete]);

	const openLlmSettings = useCallback(() => {
		dispatch({
			type: 'NAV_GO',
			routeName: 'Config',
			sectionName: 'threeR',
		});
	}, [dispatch]);

	const checkLlmSettings = useCallback(async () => {
		if (checkingLlm) return;
		setCheckingLlm(true);
		try {
			const response = await RecordAnalysisService.checkLlmConfigurationPrompt();
			Alert.alert(_('LLM configuration check succeeded'), response);
		} catch (error) {
			Alert.alert(_('LLM configuration check failed'), `${error}`);
		} finally {
			setCheckingLlm(false);
		}
	}, [checkingLlm]);

	if (loading) return <View style={styles.loadingContainer}><ActivityIndicator size="large" /></View>;
	if (!record) {
		return (
			<View style={styles.emptyState}>
				<Text style={styles.emptyStateText}>{_('This 3R record could not be found.')}</Text>
			</View>
		);
	}

	return (
		<ScrollView style={styles.analysisContainer} showsVerticalScrollIndicator={false}>
			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>{record.note.title || _('Untitled record')}</Text>
				<Text style={styles.analysisMeta}>{_('Type: %s', record.record.entry_type)}  {_('Tags: %s', record.tags.join(', ') || _('None'))}</Text>
				<Text style={styles.analysisBody}>{record.note.body || _('This record has no body yet.')}</Text>
				<TouchableOpacity
					style={[styles.primaryActionButton, processing && styles.saveButtonDisabled]}
					onPress={runReflectNow}
					disabled={processing}
				>
					<Text style={styles.primaryActionButtonText}>{processing ? _('Initiating Reflect...') : _('Initiate Reflect')}</Text>
				</TouchableOpacity>
				<TouchableOpacity style={styles.primaryActionButton} onPress={openNote}>
					<Text style={styles.primaryActionButtonText}>{_('Open original note for editing')}</Text>
				</TouchableOpacity>
				<TouchableOpacity
					style={[styles.secondaryActionButton, checkingLlm && styles.saveButtonDisabled]}
					onPress={checkLlmSettings}
					disabled={checkingLlm}
				>
					<Text style={styles.secondaryActionButtonText}>{checkingLlm ? _('Checking...') : _('LLM Configuration Check')}</Text>
				</TouchableOpacity>
				<TouchableOpacity style={styles.secondaryActionButton} onPress={openLlmSettings}>
					<Text style={styles.secondaryActionButtonText}>{_('Configure LLM API')}</Text>
				</TouchableOpacity>
			</View>
		</ScrollView>
	);
};

const RecordScreenComponent: React.FC<Props> = ({ themeId, dispatch }) => {
	const theme: ThemeStyle = themeStyle(themeId);
	const styles = useMemo(() => createStyles(theme), [theme]);
	const [detailTab, setDetailTab] = useState<'record' | 'reflect' | 'refine'>('record');
	const [detailRecordId, setDetailRecordId] = useState('');
	const [refreshKey, setRefreshKey] = useState(0);

	const handleRecordCreated = useCallback((record: RecordWithNote) => {
		setDetailRecordId(record.record.id);
		setDetailTab('record');
		setRefreshKey(k => k + 1);
	}, []);

	const closeRecord = useCallback(() => {
		setDetailRecordId('');
		setDetailTab('record');
	}, []);

	if (detailRecordId) {
		return (
			<View style={styles.container}>
				<ScreenHeader
					title={_('3R Journal')}
					showSideMenuButton={false}
					showSearchButton={false}
				/>
				<View style={styles.tabBar}>
					<TouchableOpacity style={styles.tab} onPress={closeRecord}>
						<Text style={styles.tabText}>{_('Back')}</Text>
					</TouchableOpacity>
					<TouchableOpacity
						style={[styles.tab, detailTab === 'record' && styles.activeTab]}
						onPress={() => setDetailTab('record')}
					>
						<Text style={[styles.tabText, detailTab === 'record' && styles.activeTabText]}>
							{_('Record')}
						</Text>
					</TouchableOpacity>
					<TouchableOpacity
						style={[styles.tab, detailTab === 'reflect' && styles.activeTab]}
						onPress={() => setDetailTab('reflect')}
					>
						<Text style={[styles.tabText, detailTab === 'reflect' && styles.activeTabText]}>
							{_('Reflect')}
						</Text>
					</TouchableOpacity>
					<TouchableOpacity
						style={[styles.tab, detailTab === 'refine' && styles.activeTab]}
						onPress={() => setDetailTab('refine')}
					>
						<Text style={[styles.tabText, detailTab === 'refine' && styles.activeTabText]}>
							{_('Refine')}
						</Text>
					</TouchableOpacity>
				</View>
				{detailTab === 'record' ? (
					<RecordDetailRecordView theme={theme} recordId={detailRecordId} dispatch={dispatch} onReflectComplete={() => setDetailTab('reflect')} />
				) : detailTab === 'reflect' ? (
					<RecordReflectView theme={theme} recordId={detailRecordId} />
				) : (
					<RecordRefineView theme={theme} recordId={detailRecordId} />
				)}
			</View>
		);
	}

	return (
		<View style={styles.container}>
			<ScreenHeader
				title={_('3R Journal')}
				showSideMenuButton={true}
				showSearchButton={false}
			/>

			<RecordCreateView
				key={refreshKey}
				theme={theme}
				dispatch={dispatch}
				onRecordCreated={handleRecordCreated}
			/>
		</View>
	);
};

const RecordScreen = connect((state: AppState) => {
	return {
		themeId: state.settings.theme,
	};
})(RecordScreenComponent);

export default RecordScreen;
