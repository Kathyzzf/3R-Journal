import * as React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import createStyles from './styles';
import { ThemeStyle } from '../../global-style';
import time from '@joplin/lib/time';

const ENTRY_TYPE_ICONS: Record<string, string> = {
	text: '📝',
	voice: '🎤',
	drawing: '✏️',
	image: '📷',
	file: '📄',
	audio: '🎵',
	video: '🎬',
	weblink: '🔗',
	youtube: '▶️',
};

interface Props {
	theme: ThemeStyle;
	title: string;
	snippet: string;
	entryType: string;
	tags: string[];
	updatedTime: number;
	onPress: () => void;
	onReplayPress?: () => void;
	onReflectPress?: () => void;
}

const RecordCard: React.FC<Props> = ({ theme, title, snippet, entryType, tags, updatedTime, onPress, onReplayPress, onReflectPress }) => {
	const styles = createStyles(theme);
	const icon = ENTRY_TYPE_ICONS[entryType] || '📝';
	const timeStr = updatedTime ? time.formatMsToLocal(updatedTime) : '';

	return (
		<TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
			<View style={styles.cardHeader}>
				<Text style={styles.cardTitle} numberOfLines={1}>
					{title || '无标题'}
				</Text>
				<Text style={styles.cardTypeIcon}>{icon}</Text>
			</View>
			{snippet ? (
				<Text style={styles.cardSnippet} numberOfLines={2}>
					{snippet}
				</Text>
			) : null}
			<View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
				{onReplayPress ? (
					<TouchableOpacity style={styles.cardReplayButton} onPress={onReplayPress}>
						<Text style={styles.cardReplayButtonText}>播放视频</Text>
					</TouchableOpacity>
				) : null}
				{onReflectPress ? (
					<TouchableOpacity style={styles.cardReplayButton} onPress={onReflectPress}>
						<Text style={styles.cardReplayButtonText}>Reflect</Text>
					</TouchableOpacity>
				) : null}
			</View>
			<View style={styles.cardFooter}>
				<View style={styles.cardTags}>
					{tags.slice(0, 3).map(tag => (
						<View key={tag} style={styles.cardTag}>
							<Text style={styles.cardTagText}>{tag}</Text>
						</View>
					))}
					{tags.length > 3 && (
						<View style={styles.cardTag}>
							<Text style={styles.cardTagText}>+{tags.length - 3}</Text>
						</View>
					)}
				</View>
				<Text style={styles.cardTime}>{timeStr}</Text>
			</View>
		</TouchableOpacity>
	);
};

export default RecordCard;
