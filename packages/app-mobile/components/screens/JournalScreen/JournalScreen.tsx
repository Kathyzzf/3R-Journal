import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { connect } from 'react-redux';
import { Dispatch } from 'redux';
import ScreenHeader from '../../ScreenHeader';
import { themeStyle, ThemeStyle } from '../../global-style';
import { AppState } from '../../../utils/types';
import RecordCreateView from '../RecordScreen/RecordCreateView';
import RecordBrowseView from '../RecordScreen/RecordBrowseView';

interface Props {
	themeId: number;
	dispatch: Dispatch;
}

type TabId = 'record' | 'review' | 'reflect';

interface TabDef {
	id: TabId;
	label: string;
	icon: string;
}

const TABS: TabDef[] = [
	{ id: 'record', label: '记录', icon: '📝' },
	{ id: 'review', label: '复习', icon: '📖' },
	{ id: 'reflect', label: '复盘', icon: '💡' },
];

const JournalScreenComponent: React.FC<Props> = ({ themeId, dispatch }) => {
	const theme: ThemeStyle = themeStyle(themeId);
	const styles = useMemo(() => createStyles(theme), [theme]);
	const [activeTab, setActiveTab] = useState<TabId>('record');
	const [recordSubTab, setRecordSubTab] = useState<'create' | 'browse'>('create');
	const [refreshKey, setRefreshKey] = useState(0);

	const handleRecordCreated = useCallback(() => {
		setRecordSubTab('browse');
		setRefreshKey(k => k + 1);
	}, []);

	const renderTabContent = () => {
		switch (activeTab) {
		case 'record':
			return (
				<View style={styles.tabContent}>
					{/* Record sub-tab bar */}
					<View style={styles.subTabBar}>
						<TouchableOpacity
							style={[styles.subTab, recordSubTab === 'create' && styles.subTabActive]}
							onPress={() => setRecordSubTab('create')}
						>
							<Text style={[styles.subTabText, recordSubTab === 'create' && styles.subTabTextActive]}>
								创建
							</Text>
						</TouchableOpacity>
						<TouchableOpacity
							style={[styles.subTab, recordSubTab === 'browse' && styles.subTabActive]}
							onPress={() => setRecordSubTab('browse')}
						>
							<Text style={[styles.subTabText, recordSubTab === 'browse' && styles.subTabTextActive]}>
								浏览
							</Text>
						</TouchableOpacity>
					</View>
					{recordSubTab === 'create' ? (
						<RecordCreateView
							theme={theme}
							dispatch={dispatch}
							onRecordCreated={handleRecordCreated}
						/>
					) : (
						<RecordBrowseView
							key={refreshKey}
							theme={theme}
							dispatch={dispatch}
						/>
					)}
				</View>
			);
		case 'review':
			return (
				<View style={styles.placeholder}>
					<Text style={styles.placeholderIcon}>📖</Text>
					<Text style={styles.placeholderTitle}>复习</Text>
					<Text style={styles.placeholderText}>
						复习功能即将上线，敬请期待...
					</Text>
				</View>
			);
		case 'reflect':
			return (
				<View style={styles.placeholder}>
					<Text style={styles.placeholderIcon}>💡</Text>
					<Text style={styles.placeholderTitle}>复盘</Text>
					<Text style={styles.placeholderText}>
						复盘功能即将上线，敬请期待...
					</Text>
				</View>
			);
		}
	};

	return (
		<View style={styles.container}>
			<ScreenHeader
				title="3R Journal"
				showSideMenuButton={true}
				showSearchButton={false}
			/>

			{/* Welcome banner — only shows when no records exist and on record tab */}
			{activeTab === 'record' && recordSubTab === 'create' && (
				<View style={styles.banner}>
					<Text style={styles.bannerTitle}>创建你的第一个复盘手帐</Text>
					<Text style={styles.bannerSubtitle}>
						记录 → 复习 → 复盘，养成高效学习习惯
					</Text>
				</View>
			)}

			{/* 3R Tab content area */}
			<View style={styles.contentArea}>
				{renderTabContent()}
			</View>

			{/* Bottom 3R tab bar */}
			<View style={styles.bottomTabBar}>
				{TABS.map(tab => {
					const isActive = activeTab === tab.id;
					return (
						<TouchableOpacity
							key={tab.id}
							style={[styles.bottomTab, isActive && styles.bottomTabActive]}
							onPress={() => setActiveTab(tab.id)}
							activeOpacity={0.7}
						>
							<Text style={[styles.bottomTabIcon, isActive && styles.bottomTabIconActive]}>
								{tab.icon}
							</Text>
							<Text style={[styles.bottomTabLabel, isActive && styles.bottomTabLabelActive]}>
								{tab.label}
							</Text>
						</TouchableOpacity>
					);
				})}
			</View>
		</View>
	);
};

const createStyles = (theme: ThemeStyle) => {
	return StyleSheet.create({
		container: {
			flex: 1,
			backgroundColor: theme.backgroundColor,
		},
		banner: {
			backgroundColor: theme.color4,
			paddingVertical: 16,
			paddingHorizontal: 20,
		},
		bannerTitle: {
			color: '#FFFFFF',
			fontSize: 18,
			fontWeight: '700',
		},
		bannerSubtitle: {
			color: 'rgba(255,255,255,0.8)',
			fontSize: 13,
			marginTop: 4,
		},
		contentArea: {
			flex: 1,
		},
		tabContent: {
			flex: 1,
		},
		// Sub-tab bar (Create / Browse within Record)
		subTabBar: {
			flexDirection: 'row',
			backgroundColor: theme.backgroundColor2,
			borderBottomWidth: 1,
			borderBottomColor: theme.dividerColor,
		},
		subTab: {
			flex: 1,
			paddingVertical: 10,
			alignItems: 'center',
		},
		subTabActive: {
			borderBottomWidth: 2,
			borderBottomColor: theme.color4,
		},
		subTabText: {
			fontSize: 14,
			color: theme.colorFaded,
			fontWeight: '500',
		},
		subTabTextActive: {
			color: theme.color4,
			fontWeight: '700',
		},
		// Bottom 3R tab bar
		bottomTabBar: {
			flexDirection: 'row',
			backgroundColor: theme.backgroundColor2,
			borderTopWidth: 1,
			borderTopColor: theme.dividerColor,
			paddingBottom: 4,
		},
		bottomTab: {
			flex: 1,
			alignItems: 'center',
			paddingVertical: 8,
		},
		bottomTabActive: {
			// Active state
		},
		bottomTabIcon: {
			fontSize: 22,
			opacity: 0.5,
		},
		bottomTabIconActive: {
			opacity: 1,
		},
		bottomTabLabel: {
			fontSize: 11,
			color: theme.colorFaded,
			marginTop: 2,
			fontWeight: '500',
		},
		bottomTabLabelActive: {
			color: theme.color4,
			fontWeight: '700',
		},
		// Placeholder for Review / Reflect tabs
		placeholder: {
			flex: 1,
			justifyContent: 'center',
			alignItems: 'center',
			padding: 40,
		},
		placeholderIcon: {
			fontSize: 56,
		},
		placeholderTitle: {
			fontSize: 20,
			fontWeight: '700',
			color: theme.color,
			marginTop: 16,
		},
		placeholderText: {
			fontSize: 14,
			color: theme.colorFaded,
			textAlign: 'center',
			marginTop: 8,
			lineHeight: 20,
		},
	});
};

const JournalScreen = connect((state: AppState) => {
	return {
		themeId: state.settings.theme,
	};
})(JournalScreenComponent);

export default JournalScreen;
