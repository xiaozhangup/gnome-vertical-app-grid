import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class EssentialTweaksPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const builder = new Gtk.Builder();

    // Load the UI file
    builder.add_from_file(`${this.path}/prefs.ui`);
    window.add(builder.get_object('preferences-page'));

    // Bind the UI to the settings
    const properties = [
      ['animate-scroll', 'active'],
      ['columns', 'value'],
      ['favorites-section', 'active'],
      ['horizontal-scroll', 'active'],
      ['icon-size', 'value'],
      ['icon-spacing', 'value'],
      ['two-column-groups', 'active']
    ];

    properties.forEach(([key, property]) => {
      settings.bind(key, builder.get_object(key), property, Gio.SettingsBindFlags.DEFAULT);
    });

    this._bindComboRow(builder, settings, 'app-sorting', ['usage', 'alphabetical', 'manual']);
    this._bindComboRow(builder, settings, 'favorites-sorting', ['dash', 'usage', 'alphabetical', 'manual']);

    this._hiddenAppsGroup = new Adw.PreferencesGroup({
      title: _('Hidden Apps')
    });

    builder.get_object('preferences-page').add(this._hiddenAppsGroup);
    this._populateHiddenAppsGroup(settings);

    const hiddenAppsChangedId = settings.connect('changed::hidden-apps', () => {
      this._populateHiddenAppsGroup(settings);
    });

    window.connect('close-request', () => {
      settings.disconnect(hiddenAppsChangedId);
    });
  }

  _bindComboRow(builder, settings, key, values) {
    const comboRow = builder.get_object(key);
    const sync = () => comboRow.set_selected(Math.max(0, values.indexOf(settings.get_string(key))));

    sync();
    const changedId = settings.connect(`changed::${key}`, sync);
    comboRow.connect('destroy', () => settings.disconnect(changedId));

    comboRow.connect('notify::selected', () => {
      const value = values[comboRow.selected];
      if (value !== undefined && value !== settings.get_string(key)) {
        settings.set_string(key, value);
      }
    });
  }

  _populateHiddenAppsGroup(settings) {
    if (this._hiddenAppRows) {
      this._hiddenAppRows.forEach(row => this._hiddenAppsGroup.remove(row));
    }

    this._hiddenAppRows = [];

    const hiddenApps = settings.get_strv('hidden-apps');

    if (hiddenApps.length === 0) {
      this._addHiddenAppRow(new Adw.ActionRow({
        title: _('No Hidden Apps')
      }));

      return;
    }

    hiddenApps.forEach(appId => {
      const appInfo = Gio.DesktopAppInfo.new(appId);
      const row = this._createHiddenAppRow(appId, appInfo, settings);

      this._addHiddenAppRow(row);
    });
  }

  _createHiddenAppRow(appId, appInfo, settings) {
    const row = new Adw.ActionRow({
      icon_name: appInfo?.get_icon()?.to_string() ?? 'application-x-executable',
      title: appInfo?.get_name() ?? appId,
      subtitle: appInfo?.get_description() ?? _('Missing app info')
    });

    const button = new Gtk.Button({
      icon_name: 'edit-delete-symbolic',
      tooltip_text: _('Unhide'),
      valign: Gtk.Align.CENTER
    });

    button.connect('clicked', () => {
      const hiddenApps = settings.get_strv('hidden-apps')
        .filter(hiddenAppId => hiddenAppId !== appId);

      settings.set_strv('hidden-apps', hiddenApps);
    });

    row.add_suffix(button);
    row.activatable_widget = button;

    return row;
  }

  _addHiddenAppRow(row) {
    this._hiddenAppsGroup.add(row);
    this._hiddenAppRows.push(row);
  }
}
