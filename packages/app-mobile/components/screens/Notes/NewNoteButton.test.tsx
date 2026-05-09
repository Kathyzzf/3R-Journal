import * as React from 'react';
import TestProviderStack from '../../testing/TestProviderStack';
import NewNoteButton from './NewNoteButton';
import { AppState } from '../../../utils/types';
import { Store } from 'redux';
import createMockReduxStore from '../../../utils/testing/createMockReduxStore';
import setupGlobalStore from '../../../utils/testing/setupGlobalStore';
import { act, fireEvent, render, screen, waitFor } from '../../../utils/testing/testingLibrary';
import { AccessibilityActionInfo } from 'react-native';
import { setupDatabaseAndSynchronizer } from '@joplin/lib/testing/test-utils';
import Folder from '@joplin/lib/models/Folder';
import NavService from '@joplin/lib/services/NavService';
import Setting from '@joplin/lib/models/Setting';

let testStore: Store<AppState>;

interface WrappedNewNoteButtonProps {}

const WrappedNewNoteButton: React.FC<WrappedNewNoteButtonProps> = () => {
	return <TestProviderStack store={testStore}>
		<NewNoteButton/>
	</TestProviderStack>;
};

describe('NewNoteButton', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(0);
		testStore = createMockReduxStore();
		setupGlobalStore(testStore);

		// Set an initial folder
		const folder = await Folder.save({ title: 'Test folder' });
		Setting.setValue('activeFolderId', folder.id);
		await NavService.go('Notes', { folderId: folder.id });
	});

	test('should be possible to open the 3R Journal using accessibility actions', async () => {
		const dispatchMock = jest.fn();
		NavService.dispatch = dispatchMock;
		const wrapper = render(<WrappedNewNoteButton/>);

		const toggleButton = screen.getByRole('button', { name: 'Add new' });
		expect(toggleButton).toBeVisible();

		const actions: AccessibilityActionInfo[] = toggleButton.props.accessibilityActions;
		const newNoteAction = actions.find(action => action.label === 'New 3R Journal');
		expect(newNoteAction).toBeTruthy();

		const onAction = toggleButton.props.onAccessibilityAction;
		await act(() => {
			return onAction({ nativeEvent: { actionName: newNoteAction.name } });
		});

		await waitFor(() => {
			expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
				routeName: 'Record',
				type: 'NAV_GO',
			}));
		});

		wrapper.unmount();
	});

	test('should open the 3R Journal when pressing the add button', async () => {
		const dispatchMock = jest.fn();
		NavService.dispatch = dispatchMock;
		const wrapper = render(<WrappedNewNoteButton/>);

		fireEvent.press(screen.getByRole('button', { name: 'Add new' }));

		await waitFor(() => {
			expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
				routeName: 'Record',
				type: 'NAV_GO',
			}));
		});

		wrapper.unmount();
	});
});
