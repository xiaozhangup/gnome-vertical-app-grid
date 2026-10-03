import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import { VerticalAppDisplay } from './appDisplay.js';

export default class VerticalAppGridExtension extends Extension {
  enable() {
    const extension = this;
    const overviewControlsProto = OverviewControls.ControlsManager.prototype;

    this._settings = this.getSettings();
    const settings = this._settings;
    this._vertAppDisplay = new VerticalAppDisplay(this._settings);
    this._injectionManager = new InjectionManager();

    // Add the vertical app display to the overview
    this._overviewControls = Main.overview._overview._controls;
    this._overviewLayoutManager = this._overviewControls.layout_manager;

    // Publish our folders for native observers, but let native redisplay own only its icons.
    this._injectionManager.overrideMethod(this._overviewControls.appDisplay, '_redisplay', originalFn => function (...args) {
      extension._vertAppDisplay._unpublishFolders();
      return originalFn.apply(this, args);
    });
    this._injectionManager.overrideMethod(this._overviewControls.appDisplay, '_loadApps', originalFn => function (...args) {
      const apps = originalFn.apply(this, args);
      extension._vertAppDisplay._publishFolders(false);
      return apps;
    });
    this._vertAppDisplay.registerFolders(this._overviewControls.appDisplay);

    this._overviewControls.add_child(this._vertAppDisplay);

    // Steal the layout of the original app display
    this._overviewLayoutManager._appDisplay = this._vertAppDisplay;
    this._overviewControls.appDisplay.hide();
    this._overviewControls.appDisplay._disconnectDnD();

    this._injectionManager.overrideMethod(overviewControlsProto, '_updateAppDisplayVisibility', () => function (params = null) {
      if (!params) {
        params = this._stateAdjustment.getStateTransitionParams();
      }

      const { initialState, finalState } = params;
      const state = Math.max(initialState, finalState);

      extension._vertAppDisplay.visible =
        state > OverviewControls.ControlsState.WINDOW_PICKER &&
        !this._searchController.searchActive;

      // Focus the vertical app display
      if (extension._vertAppDisplay.visible) {
        global.stage.set_key_focus(extension._vertAppDisplay);
      }

      this.appDisplay.hide();
    });

    // Fade out the app display when the search becomes active
    this._injectionManager.overrideMethod(overviewControlsProto, '_onSearchChanged', originalFn => function () {
      originalFn.call(this);

      const { searchActive } = this._searchController;

      extension._vertAppDisplay.ease({
        opacity: searchActive ? 0 : 255,
        duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      });
    });

    // Rename the "Pin to Dash" item in the app menu
    this._injectionManager.overrideMethod(AppMenu.AppMenu.prototype, '_updateFavoriteItem', originalFn => function () {
      originalFn.call(this);

      if (this._toggleFavoriteItem.visible) {
        const text = this._appFavorites.isFavorite(this._app.id)
          ? _('Remove from Favorites')
          : _('Add to Favorites');

        this._toggleFavoriteItem.label.text = text;
      }
    });

    // Add an action to hide apps from the vertical app grid
    this._injectionManager.overrideMethod(AppMenu.AppMenu.prototype, '_updateDetailsVisibility', originalFn => function () {
      originalFn.call(this);

      if (this._verticalAppGridHideItem) {
        return;
      }

      this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._verticalAppGridHideItem = this.addAction(_('Hide App'), () => {
        const hiddenApps = settings.get_strv('hidden-apps');
        const appId = this._app.get_id();

        if (!hiddenApps.includes(appId)) {
          hiddenApps.push(appId);
          settings.set_strv('hidden-apps', hiddenApps);
        }
      });
    });
  }

  disable() {
    this._overviewLayoutManager._appDisplay = this._overviewControls.appDisplay;

    this._overviewControls.remove_child(this._vertAppDisplay);
    this._injectionManager.clear();
    this._vertAppDisplay.destroy();

    this._overviewControls._updateAppDisplayVisibility();

    this._settings = null;
    this._vertAppDisplay = null;
    this._injectionManager = null;
    this._overviewControls = null;
    this._overviewLayoutManager = null;
  }
}
