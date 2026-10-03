import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { moveItem } from './appOrder.js';

function easeOutCubic(t) {
  return (--t) * t * t + 1;
}

const PINYIN_BOUNDARIES = [
  ['A', '阿'],
  ['B', '八'],
  ['C', '嚓'],
  ['D', '搭'],
  ['E', '蛾'],
  ['F', '发'],
  ['G', '噶'],
  ['H', '哈'],
  ['J', '击'],
  ['K', '喀'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拿'],
  ['O', '哦'],
  ['P', '啪'],
  ['Q', '期'],
  ['R', '然'],
  ['S', '撒'],
  ['T', '塌'],
  ['W', '挖'],
  ['X', '昔'],
  ['Y', '压'],
  ['Z', '匝']
];

const MAX_BALANCED_COLUMN_LEAD = 2;
const SCROLL_EDGE_MARGIN = 64;

let pinyinCollator = null;

function getPinyinCollator() {
  if (pinyinCollator === null) {
    pinyinCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base' });
  }

  return pinyinCollator;
}

function isCjkCharacter(char) {
  const code = char.codePointAt(0);

  return (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf);
}

function getChineseInitial(char) {
  const collator = getPinyinCollator();
  let initial = '#';

  for (const [letter, boundary] of PINYIN_BOUNDARIES) {
    if (collator.compare(char, boundary) < 0) {
      break;
    }

    initial = letter;
  }

  return initial;
}

function getAppInitial(appInfo) {
  const name = appInfo.get_name() || appInfo.get_id();

  for (const char of name.trim()) {
    const ascii = char.normalize('NFD').match(/[A-Za-z]/);

    if (ascii) {
      return ascii[0].toUpperCase();
    }

    if (isCjkCharacter(char)) {
      return getChineseInitial(char);
    }

    if (/\d/.test(char)) {
      return '#';
    }
  }

  return '#';
}

function compareAppNames(a, b) {
  return a.get_name().localeCompare(b.get_name(), undefined, { sensitivity: 'base' });
}

function isHorizontalScroll(settings) {
  return settings.get_boolean('horizontal-scroll');
}

export const VerticalAppDisplay = GObject.registerClass(
class VerticalAppDisplay extends St.Widget {
  _init(settings) {
    this._settings = settings;
    this._laters = global.compositor.get_laters();

    super._init({
      layout_manager: new Clutter.BinLayout(),
      can_focus: true,
      reactive: true
    });

    this._delegate = this;
    this._scrollView = new VerticalScrollView(settings);
    this.add_child(this._scrollView);

    this._sections = [];
    this._appIcons = [];
    this._folderIcons = new Map();
    this._folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
    this._currentDialog = null;
    this._dragSource = null;
    this._redisplayPending = false;
    this._groupColumnsBox = null;
    this._groupColumns = [];
    this._viewModeRow = null;
    this._viewModeSwitch = null;
    this._viewModeButtons = null;
    this._letterPickerOpen = false;
    this._hasFavoritesSection = false;

    this._appSystem = Shell.AppSystem.get_default();
    this._appUsage = Shell.AppUsage.get_default();
    this._appFavorites = AppFavorites.getAppFavorites();
    this._parentalControls = ParentalControlsManager.getDefault();
    this._overview = Main.overview;

    this._connectSignals();
    this._addAppIcons();
    this._updateLabelMargins();
  }

  _connectSignals() {
    // Redisplay the app grid when an app was installed or removed
    this._appSystem.connectObject('installed-changed', () => {
      this._redisplay();
    }, this);

    // Redisplay when favorites change
    this._appFavorites.connectObject('changed', () => {
      this._redisplay();
    }, this);

    // Redisplay when parental controls change
    this._parentalControls.connectObject('app-filter-changed', () => {
      this._redisplay();
    }, this);

    // Reset scroll when the overview is hidden
    this._overview.connectObject('hidden', () => {
      this._currentDialog?.popdown();
      this._gridScroll = 0;
      this._jumpToInitial = null;
      this._focusAppId = null;
      this._setLetterPickerOpen(false);
      this._scrollView.scrollTo(0, false);
    }, this);

    this._overview.connectObject(
      'item-drag-begin', (_overview, source) => this._onDragBegin(source),
      'item-drag-end', () => this._onDragEnd(),
      'item-drag-cancelled', () => this._clearDropHint(),
      this);
    this._folderSettings.connectObject('changed::folder-children', () => this._redisplay(), this);

    // Update layout when settings change
    this._settings.connectObject('changed', (_, key) => {
      switch (key) {
        case 'app-sorting':
        case 'app-order':
        case 'favorites-section':
        case 'favorites-sorting':
        case 'group-apps':
        case 'hidden-apps':
        case 'horizontal-scroll':
        case 'two-column-groups':
          this._updateViewModeSwitch(true);
          if (['group-apps', 'horizontal-scroll', 'two-column-groups'].includes(key)) {
            this._scrollView.scrollTo(0, false);
          }
          return this._redisplay();

        case 'icon-spacing':
          return this._updateLabelMargins();

        case 'icon-size':
          return this._updateIconSize();
      }
    }, this);
  }

  _addViewModeSwitch() {
    if (this._viewModeSwitch) {
      return;
    }

    const row = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false
    });

    const actor = new St.BoxLayout({
      vertical: false,
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      y_expand: false
    });
    actor._delegate = { handleDragOver: () => DND.DragMotionResult.NO_DROP };

    const allButton = this._createViewModeButton(_('All'), false);
    const groupedButton = this._createViewModeButton('A-Z', true);

    actor.add_child(allButton);
    actor.add_child(groupedButton);

    row.add_child(actor);

    this._viewModeRow = row;
    this._viewModeSwitch = actor;
    this._viewModeButtons = {
      all: allButton,
      grouped: groupedButton
    };

    this._scrollView.add_child(row);
    this._letterPicker = new St.Widget({
      layout_manager: new Clutter.GridLayout({ row_spacing: 10, column_spacing: 10 }),
      x_align: Clutter.ActorAlign.CENTER,
      accessible_name: _('Jump to Letter'),
      visible: false
    });
    this._scrollView.add_child(this._letterPicker);
    this._updateViewModeSwitch();
  }

  _createViewModeButton(label, grouped) {
    const button = new St.Button({
      label,
      can_focus: true,
      reactive: true
    });

    button.connect('clicked', () => {
      if (this._settings.get_boolean('group-apps') === grouped) {
        this._setLetterPickerOpen(!this._letterPickerOpen);
        return;
      }
      this._settings.set_boolean('group-apps', grouped);
      this._setLetterPickerOpen(false);
    });

    return button;
  }

  _updateViewModeSwitch(animate = false) {
    if (!this._viewModeButtons) {
      return;
    }

    const groupApps = this._settings.get_boolean('group-apps');

    const activeStyle = [
      'background-color: rgba(255, 255, 255, 0.30);',
      'border-radius: 999px;',
      'font-weight: bold;',
      'transition-duration: 160ms;',
      'padding: 5px 12px;',
      'width: 66px;'
    ].join(' ');

    const inactiveStyle = [
      'background-color: transparent;',
      'border-radius: 999px;',
      'transition-duration: 160ms;',
      'padding: 5px 12px;',
      'width: 66px;'
    ].join(' ');

    this._viewModeButtons.all.set_style(groupApps ? inactiveStyle : activeStyle);
    this._viewModeButtons.grouped.set_style(groupApps ? activeStyle : inactiveStyle);

    this._fadeViewModeButton(this._viewModeButtons.all, !groupApps, animate);
    this._fadeViewModeButton(this._viewModeButtons.grouped, groupApps, animate);
  }

  _fadeViewModeButton(button, active, animate) {
    const opacity = active ? 255 : 170;
    button.remove_transition('opacity');

    if (!animate) {
      button.opacity = opacity;
      return;
    }

    button.ease({
      opacity,
      duration: 160,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC
    });
  }

  _addAppIcons() {
    const favSection = this._settings.get_boolean('favorites-section');
    const groupApps = this._settings.get_boolean('group-apps');
    const horizontalScroll = isHorizontalScroll(this._settings);
    const twoColumnGroups = this._settings.get_boolean('two-column-groups');
    const { favs, apps, allApps } = this._loadApps();

    this._hasFavoritesSection = groupApps && favSection && favs.length > 0;

    this._addViewModeSwitch();

    if (!groupApps) {
      const section = this._createSection(null);

      allApps.forEach(appInfo => this._addAppIcon(appInfo, section.view));
      this._updateLabelMargins();
      this._updateLetterPicker();
      this._publishFolders();

      return;
    }

    if (this._hasFavoritesSection) {
      const parent = horizontalScroll ? this._getHorizontalGroupParent() : this._scrollView;
      const parentKey = horizontalScroll ? 'horizontal-groups' : 'main';
      const section = this._createSection(_('Favorites'), parent, parentKey);

      favs.forEach(appInfo => this._addAppIcon(appInfo, section.view));
    }

    const groupedApps = this._groupApps(apps);

    if (horizontalScroll) {
      const parent = this._getHorizontalGroupParent();

      groupedApps.forEach(([initial, appInfos]) => {
        const section = this._createSection(initial, parent, 'horizontal-groups');

        appInfos.forEach(appInfo => this._addAppIcon(appInfo, section.view));
      });
    } else {
      const groupParents = this._getGroupSectionParents(groupedApps, twoColumnGroups);

      groupedApps.forEach(([initial, appInfos], index) => {
        const parent = groupParents[index];
        const section = this._createSection(initial, parent.actor, parent.key, parent.columnsScale);

        appInfos.forEach(appInfo => this._addAppIcon(appInfo, section.view));
      });
    }

    this._updateLabelMargins();
    this._updateLetterPicker();
    this._publishFolders();
  }

  _loadApps() {
    const installedApps = this._appSystem.get_installed();
    const hiddenApps = new Set(this._settings.get_strv('hidden-apps'));

    const favs = [];
    const apps = [];
    const allApps = [];

    this._appInfoList = installedApps.filter(appInfo => {
      try {
        return !hiddenApps.has(appInfo.get_id()) && this._parentalControls.shouldShowApp(appInfo);
      } catch {
        return false;
      }
    });

    const folderApps = new Set();
    for (const id of this._folderSettings.get_strv('folder-children')) {
      const icon = this._createFolderIcon(id);
      this._folderIcons.set(id, icon);
      if (!icon.visible) {
        continue;
      }

      icon.getAppIds().forEach(appId => folderApps.add(appId));
      const info = { get_id: () => id, get_name: () => icon.name, folderIcon: icon };
      apps.push(info);
      allApps.push(info);
    }

    // Filter out hidden apps and split off favorites
    const favSection = this._settings.get_boolean('favorites-section');

    this._appInfoList.forEach(appInfo => {
      const appId = appInfo.get_id();
      const isFav = this._appFavorites.isFavorite(appId);

      if (!folderApps.has(appId)) {
        allApps.push(appInfo);

        if (favSection && isFav) {
          favs.push(appInfo);
        } else {
          apps.push(appInfo);
        }
      }
    });

    const order = new Map(this._settings.get_strv('app-order').map((id, index) => [id, index]));
    const manualSort = (a, b) =>
      (order.get(a.get_id()) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.get_id()) ?? Number.MAX_SAFE_INTEGER) || compareAppNames(a, b);

    // Sort favorites
    const favSorting = this._settings.get_string('favorites-sorting');
    const favIds = this._appFavorites._getIds();

    favs.sort((a, b) => {
      switch (favSorting) {
        case 'manual':
          return manualSort(a, b);

        case 'dash':
          return favIds.indexOf(a.get_id()) - favIds.indexOf(b.get_id());

        case 'usage':
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': default:
          return compareAppNames(a, b);
      }
    });

    // Sort apps
    const appSorting = this._settings.get_string('app-sorting');
    const sortApps = (a, b) => {
      switch (appSorting) {
        case 'manual':
          return manualSort(a, b);

        case 'usage':
          if (a.folderIcon || b.folderIcon) {
            return Number(!!b.folderIcon) - Number(!!a.folderIcon) || compareAppNames(a, b);
          }
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': default:
          return compareAppNames(a, b);
      }
    };

    apps.sort(sortApps);
    allApps.sort(sortApps);

    return { favs, apps, allApps };
  }

  getAppInfos() {
    return this._appInfoList;
  }

  _createFolderIcon(id) {
    const path = `${this._folderSettings.path}folders/${id}/`;
    const icon = new AppDisplay.FolderIcon(id, path, this);
    icon._verticalAppGridOwner = this;
    const view = icon.view;
    const loadApps = view._loadApps.bind(view);

    // Native folders also load explicit IDs; apply this extension's hidden-app filter.
    view._loadApps = () => {
      const allowed = new Set(this.getAppInfos().map(info => info.get_id()));
      const items = loadApps().filter(item => {
        if (allowed.has(item.id)) {
          return true;
        }
        if (!view._items.has(item.id)) {
          item.destroy();
        }
        return false;
      });
      view._apps = view._apps.filter(app => allowed.has(app.id));
      return items;
    };
    view._canAccept = source => source instanceof AppDisplay.AppIcon && view.contains(source) &&
      icon._folder.is_writable('apps');
    view.removeApp = app => this._removeFromFolder(icon, app.id);
    view._redisplay();
    icon._sync();
    icon.connect('apps-changed', () => this._redisplay());
    return icon;
  }

  addFolderDialog(dialog) {
    Main.layoutManager.overviewGroup.add_child(dialog);
    const acceptDrop = dialog.acceptDrop.bind(dialog);
    dialog.acceptDrop = source => dialog._view.contains(source) &&
      this._canRemoveFromFolder(source) && acceptDrop(source);
    dialog.connect('open-state-changed', (_dialog, open) => {
      if (open) {
        this._currentDialog = dialog;
      }
    });
    // Keep the source icon alive until the native closing animation finishes.
    dialog.connect('notify::visible', () => {
      if (!dialog.visible && this._currentDialog === dialog) {
        this._currentDialog = null;
        if (this._redisplayPending) {
          this._redisplay();
        }
      }
    });
    dialog.connect('destroy', () => {
      if (this._currentDialog === dialog) {
        this._currentDialog = null;
      }
    });
  }

  selectApp(id) {
    this._focusAppId = id;
    this._redisplay();
  }

  registerFolders(appDisplay) {
    this._nativeAppDisplay = appDisplay;
    this._publishFolders();
  }

  _unpublishFolders() {
    if (this._nativeAppDisplay) {
      this._nativeAppDisplay._folderIcons = this._nativeAppDisplay._folderIcons
        .filter(icon => icon._verticalAppGridOwner !== this);
    }
  }

  _publishFolders(notify = true) {
    if (!this._nativeAppDisplay || this._destroyed) {
      return;
    }
    // Keep native folder observers (including Blur my Shell) on their normal path.
    this._unpublishFolders();
    this._nativeAppDisplay._folderIcons.push(...[...this._folderIcons.values()].filter(icon => icon.visible));
    if (notify) {
      this._nativeAppDisplay.emit('view-loaded');
    }
  }

  _updateLetterPicker() {
    this._letterPicker.destroy_all_children();
    const favorites = this._hasFavoritesSection;
    const initials = new Set(this._appIcons
      .filter(icon => !favorites || !icon.app || !this._appFavorites.isFavorite(icon.id))
      .map(icon => getAppInitial({ get_name: () => icon.name, get_id: () => icon.id })));
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
    if (favorites &&
        this._appIcons.some(icon => icon.app && this._appFavorites.isFavorite(icon.id))) {
      letters.unshift('★');
      initials.add('★');
    }

    letters.forEach((letter, index) => {
      const enabled = initials.has(letter);
      const button = new St.Button({
        label: letter,
        accessible_name: letter === '★' ? _('Favorites') : letter,
        can_focus: enabled,
        reactive: enabled,
        style_class: 'button vertical-app-grid-letter'
      });
      if (!enabled) {
        button.add_style_pseudo_class('insensitive');
      }
      button.connect('clicked', () => {
        this._jumpToInitial = letter === '★' ? _('Favorites') : letter;
        this._setLetterPickerOpen(false);
      });
      this._letterPicker.layout_manager.attach(button, index % 7, Math.floor(index / 7), 1, 1);
    });
    this._letterPicker.visible = this._letterPickerOpen;
    this._getRedisplayActors().forEach(actor => actor.visible = !this._letterPickerOpen);
    this._updateViewModeRowWidth();
  }

  _setLetterPickerOpen(open) {
    if (this._letterPickerOpen === open) {
      return;
    }
    if (open) {
      this._gridScroll = this._scrollView.scrollAdjustment.value;
      this._jumpToInitial = null;
    }
    this._letterPickerOpen = open;
    this._letterPicker.visible = open;
    this._getRedisplayActors().forEach(actor => actor.visible = !open);
    this._updateViewModeRowWidth();
    this._animateRedisplay();
    this._queueScroll(open ? 0 : this._gridScroll ?? 0);
    const focus = open
      ? this._letterPicker.get_children().find(button => button.can_focus)
      : this._viewModeButtons[this._settings.get_boolean('group-apps') ? 'grouped' : 'all'];
    if (focus?.mapped) {
      focus.grab_key_focus();
    }
  }

  _createSection(title, parent = this._scrollView, parentKey = 'main', columnsScale = 1) {
    const actor = new St.BoxLayout({
      vertical: true,
      x_expand: false,
      y_expand: false
    });

    let label = title
      ? new St.Label({
        style_class: 'search-statustext',
        text: title
      })
      : null;
    if (/^[A-Z#]$/.test(title ?? '')) {
      label = new St.Button({
        child: label,
        accessible_name: title,
        x_align: Clutter.ActorAlign.START,
        can_focus: true
      });
      label.connect('clicked', () => this._setLetterPickerOpen(true));
    }

    const view = new St.Viewport({
      layout_manager: new VerticalLayout(this._settings, columnsScale)
    });

    const section = { actor, label, view, parentKey, title };
    view._verticalSection = section;
    view._delegate = {
      handleDragOver: (source, _actor, x, y) => this._sectionDragOver(source, section, x, y),
      acceptDrop: (source, _actor, x, y) => this._sectionDrop(source, section, x, y)
    };

    this._sections.push(section);
    if (label) {
      actor.add_child(label);
    }

    actor.add_child(view);
    parent.add_child(actor);

    return section;
  }

  _getGroupSectionParents(groups, twoColumnGroups) {
    if (!twoColumnGroups) {
      return groups.map(() => ({
        actor: this._scrollView,
        key: 'main',
        columnsScale: 1
      }));
    }

    this._ensureGroupColumns();

    const columns = this._getScaledColumns(0.5);
    const heights = [0, 0];
    const counts = [0, 0];

    return groups.map(([_initial, appInfos]) => {
      let columnIndex = heights[0] <= heights[1] ? 0 : 1;
      const otherColumnIndex = columnIndex === 0 ? 1 : 0;

      if (counts[columnIndex] - counts[otherColumnIndex] >= MAX_BALANCED_COLUMN_LEAD) {
        columnIndex = otherColumnIndex;
      }

      counts[columnIndex]++;
      heights[columnIndex] += 1 + Math.ceil(appInfos.length / columns);

      return {
        actor: this._groupColumns[columnIndex],
        key: `group-column-${columnIndex}`,
        columnsScale: 0.5
      };
    });
  }

  _ensureGroupColumns() {
    if (this._groupColumnsBox) {
      return;
    }

    this._groupColumnsBox = new St.BoxLayout({
      vertical: false,
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false
    });

    this._groupColumns = [0, 1].map(() => new St.BoxLayout({
      vertical: true,
      x_expand: false,
      y_expand: false
    }));

    this._groupColumns.forEach(column => {
      this._groupColumnsBox.add_child(column);
    });

    this._scrollView.add_child(this._groupColumnsBox);
  }

  _getScaledColumns(columnsScale) {
    return Math.max(1, Math.floor(this._settings.get_int('columns') * columnsScale));
  }

  _getHorizontalGroupParent() {
    this._ensureHorizontalGroups();

    return this._groupColumnsBox;
  }

  _ensureHorizontalGroups() {
    if (this._groupColumnsBox) {
      return;
    }

    this._groupColumnsBox = new St.BoxLayout({
      vertical: false,
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false
    });

    this._scrollView.add_child(this._groupColumnsBox);
  }

  _addAppIcon(appInfo, view) {
    const iconSize = this._settings.get_int('icon-size');
    const app = appInfo.folderIcon ? null : this._appSystem.lookup_app(appInfo.get_id());
    if (!appInfo.folderIcon && !app) {
      return;
    }
    const appIcon = appInfo.folderIcon ?? new AppDisplay.AppIcon(app);

    appIcon._verticalSection = view._verticalSection;
    appIcon.handleDragOver = (source, _actor, x, y) =>
      this._iconDragOver(source, appIcon, x, y);
    appIcon.acceptDrop = (source, _actor, x, y) =>
      this._iconDrop(source, appIcon, x, y);

    appIcon.icon.setIconSize(iconSize);
    view.add_child(appIcon);
    this._appIcons.push(appIcon);
  }

  _groupApps(apps) {
    const groups = new Map();

    apps.forEach(appInfo => {
      const initial = getAppInitial(appInfo);

      if (!groups.has(initial)) {
        groups.set(initial, []);
      }

      groups.get(initial).push(appInfo);
    });

    return [...groups.entries()].sort(([a], [b]) => {
      if (a === '#') {
        return 1;
      }

      if (b === '#') {
        return -1;
      }

      return a.localeCompare(b);
    });
  }

  _sourceFolder(source) {
    return [...this._folderIcons.values()].find(icon => icon.view.contains(source));
  }

  _validDragSource(source) {
    return source instanceof AppDisplay.AppIcon
      ? this.getAppInfos().some(info => info.get_id() === source.id)
      : source instanceof AppDisplay.FolderIcon && this._folderIcons.get(source.id) === source;
  }

  _canRemoveFromFolder(source) {
    const folder = this._sourceFolder(source)?._folder;
    return !folder || (folder.is_writable('apps') && folder.is_writable('excluded-apps') &&
      this._folderSettings.is_writable('folder-children'));
  }

  _canDrop(source, target, mode) {
    if (this._letterPickerOpen || !this._validDragSource(source) || source === target ||
        !this._canRemoveFromFolder(source)) {
      return false;
    }

    if (mode === 'folder') {
      if (!source.app || (this._appFavorites.isFavorite(source.id) ||
          (target.app && this._appFavorites.isFavorite(target.id))) &&
          !global.settings.is_writable('favorite-apps')) {
        return false;
      }
      if (target instanceof AppDisplay.FolderIcon) {
        return !target.getAppIds().includes(source.id) && target._folder.is_writable('apps') &&
          target._folder.is_writable('excluded-apps');
      }
      return !!target.app && this._folderSettings.is_writable('folder-children');
    }

    const section = target?._verticalSection;
    const favorite = section?.title === _('Favorites');
    if (!this._settings.is_writable('app-order') ||
        !this._settings.is_writable(favorite ? 'favorites-sorting' : 'app-sorting')) {
      return false;
    }
    if (!this._settings.get_boolean('group-apps')) {
      return true;
    }
    if (!section) {
      return !!this._sourceFolder(source);
    }
    const isFavorite = source.app && this._settings.get_boolean('favorites-section') &&
      this._appFavorites.isFavorite(source.id);
    const title = isFavorite ? _('Favorites')
      : getAppInitial({ get_name: () => source.name, get_id: () => source.id });
    return section.title === title;
  }

  _dropMode(source, target, x, y) {
    const fraction = isHorizontalScroll(this._settings) ? y / target.height : x / target.width;
    if (fraction >= 0.25 && fraction <= 0.75 && source.app) {
      return 'folder';
    }
    return fraction < 0.5 ? 'before' : 'after';
  }

  _iconDragOver(source, target, x, y) {
    const mode = this._dropMode(source, target, x, y);
    if (!this._canDrop(source, target, mode)) {
      this._clearDropHint();
      return DND.DragMotionResult.NO_DROP;
    }
    this._showDropHint(target, mode);
    return DND.DragMotionResult.MOVE_DROP;
  }

  _iconDrop(source, target, x, y) {
    return this._drop(source, target, this._dropMode(source, target, x, y));
  }

  _nearestIcon(section, source, x, y) {
    let nearest = null;
    let distance = Infinity;
    for (const icon of section.view.get_children()) {
      if (icon === source) {
        continue;
      }
      const box = icon.get_allocation_box();
      const dx = x - (box.x1 + box.x2) / 2;
      const dy = y - (box.y1 + box.y2) / 2;
      if (dx * dx + dy * dy < distance) {
        distance = dx * dx + dy * dy;
        nearest = { icon, after: isHorizontalScroll(this._settings) ? dy > 0 : dx > 0 };
      }
    }
    return nearest;
  }

  _sectionDragOver(source, section, x, y) {
    const nearest = this._nearestIcon(section, source, x, y);
    if (!nearest || !this._canDrop(source, nearest.icon, 'before')) {
      this._clearDropHint();
      return DND.DragMotionResult.NO_DROP;
    }
    this._showDropHint(nearest.icon, nearest.after ? 'after' : 'before');
    return DND.DragMotionResult.MOVE_DROP;
  }

  _sectionDrop(source, section, x, y) {
    // A rejected icon drop must not turn into a gap reorder in its parent.
    if (section.view.get_children().some(icon => icon.get_allocation_box().contains(x, y))) {
      return false;
    }
    const nearest = this._nearestIcon(section, source, x, y);
    return !!nearest && this._drop(source, nearest.icon, nearest.after ? 'after' : 'before');
  }

  handleDragOver(source) {
    this._clearDropHint();
    return this._canDrop(source, null, 'after')
      ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
  }

  acceptDrop(source) {
    if (this._dropActor && this._viewModeSwitch.contains(this._dropActor)) {
      return false;
    }
    for (let actor = this._dropActor; actor && actor !== this; actor = actor.get_parent()) {
      if (actor._verticalSection) {
        return false;
      }
    }
    return this._drop(source, null, 'after');
  }

  _drop(source, target, mode) {
    this._clearDropHint();
    if (!this._canDrop(source, target, mode)) {
      return false;
    }

    const oldFolder = this._sourceFolder(source);
    if (mode === 'folder') {
      if (target instanceof AppDisplay.FolderIcon) {
        const folder = new Gio.Settings({
          schema_id: 'org.gnome.desktop.app-folders.folder',
          path: target._folder.path
        });
        folder.delay();
        folder.set_strv('apps', [...new Set([...folder.get_strv('apps'), source.id])]);
        folder.set_strv('excluded-apps', folder.get_strv('excluded-apps').filter(id => id !== source.id));
        folder.apply();
      } else {
        const id = GLib.uuid_string_random();
        const folder = new Gio.Settings({
          schema_id: 'org.gnome.desktop.app-folders.folder',
          path: `${this._folderSettings.path}folders/${id}/`
        });
        if (!folder.is_writable('name') || !folder.is_writable('apps')) {
          return false;
        }
        folder.delay();
        folder.set_string('name', _('Unnamed Folder'));
        folder.set_strv('apps', [target.id, source.id]);
        folder.apply();
        this._folderSettings.set_strv('folder-children', [...this._folderSettings.get_strv('folder-children'), id]);
        this._saveOrder(id, target.id);
        if (this._appFavorites.isFavorite(target.id)) {
          this._appFavorites.removeFavorite(target.id);
        }
      }
      if (this._appFavorites.isFavorite(source.id)) {
        this._appFavorites.removeFavorite(source.id);
      }
    } else if (!this._saveOrder(source.id, target?.id ?? null, mode === 'after',
      target?._verticalSection.title === _('Favorites'))) {
      return false;
    }

    if (oldFolder) {
      this._removeFromFolder(oldFolder, source.id);
      this._currentDialog?.popdown();
    }
    this._redisplay();
    return true;
  }

  _saveOrder(id, targetId = null, after = false, favorite = false) {
    const sortingKey = favorite ? 'favorites-sorting' : 'app-sorting';
    if (!this._settings.is_writable('app-order') || !this._settings.is_writable(sortingKey)) {
      return false;
    }
    const visible = this._appIcons.map(icon => icon.id);
    const saved = this._settings.get_strv('app-order');
    const ids = this._settings.get_string(sortingKey) === 'manual'
      ? [...saved, ...visible] : [...visible, ...saved];
    const order = moveItem(ids, id, targetId, after);
    if (!order) {
      return false;
    }
    this._settings.set_strv('app-order', order);
    this._settings.set_string(sortingKey, 'manual');
    return true;
  }

  _removeFromFolder(icon, appId) {
    const folder = new Gio.Settings({
      schema_id: 'org.gnome.desktop.app-folders.folder',
      path: icon._folder.path
    });
    if (!folder.is_writable('apps') || !folder.is_writable('excluded-apps') ||
        !this._folderSettings.is_writable('folder-children')) {
      return;
    }
    const apps = folder.get_strv('apps').filter(id => id !== appId);
    const categories = folder.get_strv('categories');
    folder.delay();
    folder.set_strv('apps', apps);
    if (categories.length > 0) {
      folder.set_strv('excluded-apps', [...new Set([...folder.get_strv('excluded-apps'), appId])]);
    }
    folder.apply();

    // Category folders may still contain implicit apps, even with an empty explicit list.
    if (apps.length === 0 && categories.length === 0) {
      this._folderSettings.set_strv('folder-children',
        this._folderSettings.get_strv('folder-children').filter(id => id !== icon.id));
      for (const key of folder.settings_schema.list_keys()) {
        folder.reset(key);
      }
      folder.apply();
    }
    this._redisplay();
  }

  _showDropHint(target, mode) {
    if (this._dropHint?.target === target && this._dropHint.mode === mode) {
      return;
    }
    this._clearDropHint();
    this._dropHint = { target, mode, style: target.get_style() };
    if (mode === 'folder') {
      target.add_style_pseudo_class('drop');
    } else {
      const horizontal = isHorizontalScroll(this._settings);
      const edge = horizontal ? (mode === 'before' ? 'top' : 'bottom')
        : (mode === 'before' ? 'left' : 'right');
      const color = target.get_theme_node().get_foreground_color().to_string();
      target.set_style(`${this._dropHint.style ?? ''}; border-${edge}: 3px solid ${color};`);
    }
  }

  _clearDropHint() {
    if (this._dropHint) {
      const { target, style } = this._dropHint;
      target.remove_style_pseudo_class('drop');
      target.set_style(style);
      this._dropHint = null;
    }
  }

  _onDragBegin(source) {
    if (!this.visible || this._letterPickerOpen || !this._validDragSource(source)) {
      return;
    }
    this._dragSource = source;
    this._dragScrollDirection = 0;
    this._dragMonitor = {
      dragDrop: event => {
        this._dropActor = event.targetActor;
        return DND.DragDropResult.CONTINUE;
      },
      dragMotion: event => {
        if (this._dropHint && !this._dropHint.target.contains(event.targetActor)) {
          this._clearDropHint();
        }
        const [ok, x, y] = this._scrollView.transform_stage_point(event.x, event.y);
        const horizontal = isHorizontalScroll(this._settings);
        const position = horizontal ? x : y;
        const size = horizontal ? this._scrollView.width : this._scrollView.height;
        this._dragScrollDirection = 0;
        if (ok && !this._currentDialog?.visible && x >= 0 && y >= 0 &&
            x <= this._scrollView.width && y <= this._scrollView.height) {
          this._dragScrollDirection = position < 48 ? -1 : position > size - 48 ? 1 : 0;
        }
        return DND.DragMotionResult.CONTINUE;
      }
    };
    DND.addDragMonitor(this._dragMonitor);
    this._dragScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      if (this._dragScrollDirection) {
        this._scrollView.scrollTo(this._scrollView.scrollAdjustment.value + this._dragScrollDirection * 24, false);
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  _onDragEnd() {
    this._clearDropHint();
    if (this._dragMonitor) {
      DND.removeDragMonitor(this._dragMonitor);
      this._dragMonitor = null;
    }
    if (this._dragScrollId) {
      GLib.source_remove(this._dragScrollId);
      this._dragScrollId = 0;
    }
    this._dragSource = null;
    this._dropActor = null;
    if (this._redisplayPending) {
      this._redisplay();
    }
  }

  _clearSections() {
    this._clearDropHint();
    this._unpublishFolders();
    new Set([...this._appIcons, ...this._folderIcons.values()]).forEach(icon => icon.destroy());
    this._folderIcons.clear();

    this._sections.forEach(({ actor, view }) => {
      view.layout_manager.destroy();
      actor.destroy();
    });

    if (this._groupColumnsBox) {
      this._groupColumnsBox.destroy();
    }

    this._appIcons = [];
    this._sections = [];
    this._groupColumnsBox = null;
    this._groupColumns = [];
    this._hasFavoritesSection = false;
  }

  _redisplay() {
    if (this._destroyed) {
      return;
    }
    this._redisplayPending = true;
    if (this._dragSource || this._redisplayLater) {
      return;
    }
    this._redisplayLater = this._laters.add(Meta.LaterType.IDLE, () => {
      this._redisplayLater = 0;
      if (this._dragSource) {
        return GLib.SOURCE_REMOVE;
      }
      if (this._currentDialog?.visible) {
        for (const icon of this._folderIcons.values()) {
          icon.view._redisplay();
          icon.icon.update();
        }
        if (this._currentDialog._view.getAllItems().length === 0) {
          this._currentDialog.popdown();
        }
        return GLib.SOURCE_REMOVE;
      }
      this._redisplayPending = false;
      const scroll = this._scrollView.scrollAdjustment.value;
      this._clearSections();
      this._addAppIcons();
      this._animateRedisplay();
      this._queueScroll(scroll);
      return GLib.SOURCE_REMOVE;
    });
  }

  _queueScroll(scroll) {
    if (this._focusLater) {
      this._laters.remove(this._focusLater);
    }
    this._focusLater = this._laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._focusLater = 0;
      if (this._redisplayPending) {
        return GLib.SOURCE_REMOVE;
      }
      const section = this._jumpToInitial
        ? this._sections.find(item => item.title === this._jumpToInitial) : null;
      const icon = this._appIcons.find(item => this._jumpToInitial
        ? getAppInitial({ get_name: () => item.name, get_id: () => item.id }) === this._jumpToInitial
        : item.id === this._focusAppId);
      if (section) {
        this._scrollView.scrollToChild(section.label, true, false);
        section.view.get_first_child()?.grab_key_focus();
      } else if (icon?.mapped) {
        this._scrollView.scrollToChild(icon, !!this._jumpToInitial, !this._jumpToInitial);
        icon.grab_key_focus();
      } else {
        this._scrollView.scrollTo(scroll, false);
      }
      this._jumpToInitial = null;
      this._focusAppId = null;
      return GLib.SOURCE_REMOVE;
    });
  }

  _animateRedisplay() {
    const pickerOpen = this._letterPickerOpen;
    const actors = pickerOpen
      ? [this._letterPicker, ...this._letterPicker.get_children()]
      : this._getRedisplayActors();
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

    actors.forEach((actor, index) => {
      // Reopening during a transition starts cleanly, without delayed callbacks.
      for (const property of ['opacity', 'translation-y', 'scale-x', 'scale-y']) {
        actor.remove_transition(property);
      }
      const isPicker = actor === this._letterPicker;
      actor.opacity = 0;
      actor.translation_y = isPicker ? 0 : 8 * scale;
      actor.set_pivot_point(0.5, 0);
      actor.scale_x = actor.scale_y = isPicker ? 0.97 : 1;
      actor.ease({
        opacity: 255,
        translation_y: 0,
        scale_x: 1,
        scale_y: 1,
        delay: pickerOpen && !isPicker ? Math.floor((index - 1) / 7) * 16 : 0,
        duration: pickerOpen ? 180 : 220,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC
      });
    });
  }

  _getRedisplayActors() {
    return this._scrollView.getContentChildren()
      .filter(actor => actor !== this._viewModeRow && actor !== this._letterPicker);
  }

  _updateLabelMargins() {
    const spacing = this._settings.get_int('icon-spacing');
    const horizontalScroll = isHorizontalScroll(this._settings);
    const viewModeGap = Math.floor(spacing / 2);
    const bottomGap = spacing * 2;
    const sectionKeys = new Set();

    if (this._viewModeSwitch) {
      this._viewModeSwitch.x_align = horizontalScroll
        ? Clutter.ActorAlign.START
        : Clutter.ActorAlign.END;

      this._viewModeSwitch.set_style([
        'background-color: rgba(255, 255, 255, 0.16);',
        'border-radius: 999px;',
        'padding: 4px;',
        'spacing: 4px;'
      ].join(' '));
    }

    if (this._viewModeRow) {
      this._viewModeRow.set_style(`margin: 0 0 ${viewModeGap}px 0;`);
    }

    this._sections.forEach(({ actor, label, parentKey }, index) => {
      const isFirstInParent = !sectionKeys.has(parentKey);
      const isHorizontalGroup = parentKey === 'horizontal-groups';
      const isLastSection = index === this._sections.length - 1;
      const top = isFirstInParent || isHorizontalGroup ? 0 : spacing * 2;
      const bottom = isLastSection && !this._groupColumnsBox ? bottomGap : 0;

      sectionKeys.add(parentKey);
      actor.set_style(`margin: ${top}px 0 ${bottom}px 0;`);

      if (label) {
        label.set_style(`margin: 0 0 ${spacing}px 0;`);
      }
    });

    if (this._groupColumnsBox) {
      const top = this._hasFavoritesSection && !horizontalScroll ? spacing * 2 : 0;

      this._groupColumnsBox.set_style(`spacing: ${spacing}px; margin: ${top}px 0 ${bottomGap}px 0;`);
    }

    this._updateViewModeRowWidth();
  }

  _updateViewModeRowWidth() {
    if (!this._viewModeRow) {
      return;
    }
    if (this._letterPickerOpen) {
      // Keep the controls anchored to the app grid, not the smaller letter picker.
      // Horizontal groups may span many screens; their controls stay at the start.
      if (isHorizontalScroll(this._settings)) {
        this._viewModeRow.set_width(Math.min(this._viewModeRow.width,
          this._scrollView.width || this._viewModeRow.width));
      }
      return;
    }

    let width = 0;

    if (this._groupColumnsBox) {
      width = this._groupColumnsBox.get_preferred_width(-1)[1];
    } else {
      this._sections.forEach(({ actor }) => {
        width = Math.max(width, actor.get_preferred_width(-1)[1]);
      });
    }

    this._viewModeRow.set_width(Math.max(width, this._viewModeSwitch.get_preferred_width(-1)[1]));
  }

  _updateIconSize() {
    const size = this._settings.get_int('icon-size');

    this._appIcons.forEach(appIcon => {
      appIcon.icon.setIconSize(size);
    });
  }

  vfunc_key_press_event(event) {
    const key = event.get_key_symbol();
    const focused = global.stage.get_key_focus();

    if (key === Clutter.KEY_Escape) {
      if (this._letterPickerOpen) {
        this._setLetterPickerOpen(false);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    // Keyboard scroll
    const adjustment = this._scrollView.scrollAdjustment;
    const pageSize = adjustment.page_size;

    const scroll = {
      [Clutter.KEY_Home]: 0,
      [Clutter.KEY_End]: adjustment.upper - pageSize,
      [Clutter.KEY_Page_Up]: this._scrollView.scroll - pageSize * 0.8,
      [Clutter.KEY_Page_Down]: this._scrollView.scroll + pageSize * 0.8
    };

    if (scroll[key] !== undefined) {
      return this._scrollView.scrollTo(scroll[key]);
    }

    // Include the view controls, group headings, and visible content in keyboard navigation.
    const navTarget = this._getNavTarget(focused, key);

    if (navTarget) {
      this._scrollView.scrollToChild(navTarget);
      navTarget.grab_key_focus();

      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _getNavTarget(focused, key) {
    if (key !== Clutter.KEY_Tab && key !== Clutter.KEY_ISO_Left_Tab) {
      return null;
    }
    const items = [
      ...this._viewModeSwitch.get_children(),
      ...(this._letterPickerOpen
        ? this._letterPicker.get_children()
        : this._sections.flatMap(({ label, view }) => [label, ...view.get_children()]))
    ].filter(item => item?.visible && item.can_focus);
    const index = items.indexOf(focused);
    const last = items.length - 1;

    let targetIndex = index;

    if (index === -1) {
      if (key === Clutter.KEY_Tab) {
        targetIndex = 0;
      } else if (key === Clutter.KEY_ISO_Left_Tab) {
        targetIndex = last;
      }
    } else {
      if (key === Clutter.KEY_Tab) {
        targetIndex = index < last ? index + 1 : 0;
      } else if (key === Clutter.KEY_ISO_Left_Tab) {
        targetIndex = index > 0 ? index - 1 : last;
      }
    }

    return items[targetIndex];
  }

  destroy() {
    this._destroyed = true;
    this._onDragEnd();
    this._appSystem.disconnectObject(this);
    this._appFavorites.disconnectObject(this);
    this._parentalControls.disconnectObject(this);
    this._overview.disconnectObject(this);
    this._settings.disconnectObject(this);
    this._folderSettings.disconnectObject(this);

    if (this._redisplayLater) {
      this._laters.remove(this._redisplayLater);
    }
    if (this._focusLater) {
      this._laters.remove(this._focusLater);
    }

    this._clearSections();
    this._scrollView.destroy();

    super.destroy();
  }
});

const VerticalScrollView = GObject.registerClass(
class VerticalScrollView extends St.ScrollView {
  _init(settings) {
    this._settings = settings;
    this._horizontalScroll = isHorizontalScroll(settings);

    this._scroll = 0;
    this._trackpadTime = 0;

    this._scrollAnim = {
      lock: null,
      startTime: 0,
      startValue: 0,
      duration: 0,
      delta: 0
    };

    super._init({
      effect: new St.ScrollViewFade({
        fade_margins: new Clutter.Margin({
          top: SCROLL_EDGE_MARGIN,
          bottom: SCROLL_EDGE_MARGIN
        })
      }),
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.NEVER,
      x_expand: true,
      y_expand: true
    });

    this._scrollBox = new St.BoxLayout({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
      x_expand: false,
      y_expand: false,
      vertical: true
    });

    this.set_child(this._scrollBox);

    this._settings.connectObject('changed::horizontal-scroll', () => {
      this._updateScrollOrientation();
    }, this);
  }

  add_child(child) {
    this._scrollBox.add_child(child);
  }

  getContentChildren() {
    return this._scrollBox.get_children();
  }

  _updateScrollOrientation() {
    this._horizontalScroll = isHorizontalScroll(this._settings);

    if (this._scrollAnim.lock) {
      this._scrollAnim.lock = global.stage.disconnect(this._scrollAnim.lock) || null;
    }

    this._scroll = 0;
    this.hadjustment.value = 0;
    this.vadjustment.value = 0;
    this.queue_relayout();
  }

  _getAdjustment() {
    return this._horizontalScroll ? this.hadjustment : this.vadjustment;
  }

  scrollToChild(child, alignStart = false, animate = true) {
    const childBox = child.get_allocation_box();

    // Get the child's position inside the scroll view on the active scroll axis.
    let actor = child;
    let childPosition = this._horizontalScroll ? childBox.x1 : childBox.y1;

    while ((actor = actor.get_parent()) !== this) {
      const actorBox = actor.get_allocation_box();

      childPosition += this._horizontalScroll ? actorBox.x1 : actorBox.y1;
    }

    // Keep letter jumps clear of the edge fade; center ordinary focus changes.
    const adjustment = this._getAdjustment();
    const childSize = this._horizontalScroll
      ? childBox.get_width()
      : childBox.get_height();

    const childCenter = childPosition + childSize / 2;
    const scroll = alignStart
      ? childPosition - SCROLL_EDGE_MARGIN
      : childCenter - adjustment.page_size / 2;

    this.scrollTo(scroll, animate);
  }

  scrollTo(scroll, animate = true, duration = 200) {
    const now = GLib.get_monotonic_time();

    const adjustment = this._getAdjustment();
    const anim = this._scrollAnim;

    // Only scroll if the clamped distance is greater than zero to prevent
    // rapidly retriggering the animation while holding down a key
    const min = adjustment.lower;
    const max = Math.max(min, adjustment.upper - adjustment.page_size);

    const scrollClamped = Math.clamp(scroll, min, max);
    const distance = Math.abs(this.scroll - scrollClamped);

    if (distance === 0 && (animate || anim.lock === null)) {
      return Clutter.EVENT_STOP;
    }

    this._scroll = scrollClamped;

    if (animate) {
      // Init scroll animation
      anim.startTime = now;
      anim.startValue = adjustment.value;
      anim.delta = scrollClamped - adjustment.value;
      anim.duration = duration * 1000;

      if (anim.lock === null) {
        anim.lock = global.stage.connect('after-paint', this._scrollAnimationFrame.bind(this));
      }
    } else {
      // Cancel running animation
      if (anim.lock) {
        anim.lock = global.stage.disconnect(anim.lock) || null;
      }

      adjustment.value = scrollClamped;
    }

    // Redraw to trigger the next animation frame
    this.queue_redraw();

    return Clutter.EVENT_STOP;
  }

  _scrollAnimationFrame() {
    const now = GLib.get_monotonic_time();

    const adjustment = this._getAdjustment();
    const anim = this._scrollAnim;

    // Animate towards the scroll target
    const elapsed = now - anim.startTime;
    const progress = Math.clamp(elapsed / anim.duration, 0, 1);

    adjustment.value = anim.startValue + anim.delta * easeOutCubic(progress);

    if (progress >= 1) {
      anim.lock = global.stage.disconnect(anim.lock) || null;
    }

    this.queue_redraw();
  }

  vfunc_scroll_event(event) {
    if (this._settings.get_boolean('animate-scroll') || this._horizontalScroll) {
      return this._animateScroll(event);
    }

    return super.vfunc_scroll_event(event);
  }

  _animateScroll(event) {
    const now = GLib.get_monotonic_time();

    // Ignore emulated events
    if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) {
      return Clutter.EVENT_STOP;
    }

    // Get scroll delta
    const adjustment = this._getAdjustment();

    const direction = event.get_scroll_direction();
    const step = adjustment.page_size ** (2 / 3);
    const animateScroll = this._settings.get_boolean('animate-scroll');

    let delta = 0;
    let animate = false;

    if (direction === Clutter.ScrollDirection.SMOOTH) {
      // Sometimes events without a smooth delta are emitted when using a
      // trackpad, so this debounce timestamp is used to prevent any sudden
      // jumps while scrolling
      this._trackpadTime = now;

      const deltas = event.get_scroll_delta();
      const orientation = this._horizontalScroll
        ? Clutter.Orientation.HORIZONTAL
        : Clutter.Orientation.VERTICAL;
      const primaryDelta = deltas[orientation] ?? 0;
      const fallbackDelta = deltas[Clutter.Orientation.VERTICAL] ?? 0;

      delta = this._horizontalScroll && primaryDelta === 0
        ? fallbackDelta
        : primaryDelta;
    } else if (now - this._trackpadTime > 1000 * 1000) {
      if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT) {
        delta = -1;
      } else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT) {
        delta = 1;
      }

      animate = animateScroll;
    }

    // Animate to the new scroll position
    const min = adjustment.lower;
    const max = Math.max(min, adjustment.upper - adjustment.page_size);

    const clampedScroll = Math.clamp(this.scroll + delta * step, min, max);
    const distance = Math.abs(this.scroll - clampedScroll);
    const duration = (distance / 100) * 200;

    if (distance === 0) {
      return Clutter.EVENT_STOP;
    }

    return this.scrollTo(clampedScroll, animate, duration);
  }

  destroy() {
    this._settings.disconnectObject(this);

    if (this._scrollAnim.lock) {
      global.stage.disconnect(this._scrollAnim.lock);
    }
    super.destroy();
  }

  get scroll() {
    return this._scrollAnim.lock ? this._scroll : this._getAdjustment().value;
  }

  get scrollAdjustment() {
    return this._getAdjustment();
  }
});

const VerticalLayout = GObject.registerClass(
class VerticalLayout extends Clutter.LayoutManager {
  _init(settings, columnsScale = 1) {
    super._init();

    this._settings = settings;
    this._columnsScale = columnsScale;
    this._reserveColumns = columnsScale < 1;
    this._horizontalScroll = isHorizontalScroll(settings);

    settings.connectObject('changed', (_, key) => {
      if (['columns', 'horizontal-scroll', 'icon-spacing'].includes(key)) {
        this._columns = this._getColumns();
        this._horizontalScroll = isHorizontalScroll(settings);
        this._spacing = settings.get_int('icon-spacing');

        this.layout_changed();
      }
    }, this);

    this._columns = this._getColumns();
    this._spacing = settings.get_int('icon-spacing');
  }

  _getColumns() {
    return Math.max(1, Math.floor(this._settings.get_int('columns') * this._columnsScale));
  }

  vfunc_get_preferred_width(container, _forHeight) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);
    const primaryCount = this._getPrimaryAxisCount(children);
    const secondaryCount = this._getSecondaryAxisCount(children);

    const size = this._horizontalScroll
      ? this._getAxisSize(secondaryCount, childSize)
      : this._getAxisSize(primaryCount, childSize);

    return [size, size];
  }

  vfunc_get_preferred_height(container, _forWidth) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);
    const primaryCount = this._getPrimaryAxisCount(children);
    const secondaryCount = this._getSecondaryAxisCount(children);

    const size = this._horizontalScroll
      ? this._getAxisSize(primaryCount, childSize)
      : this._getAxisSize(secondaryCount, childSize);

    return [size, size];
  }

  vfunc_allocate(container, _box) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const childBox = new Clutter.ActorBox();

    for (let i = 0; i < children.length; i++) {
      const col = this._horizontalScroll
        ? Math.floor(i / this._columns)
        : i % this._columns;
      const row = this._horizontalScroll
        ? i % this._columns
        : Math.floor(i / this._columns);

      const x = col * (childSize + this._spacing);
      const y = row * (childSize + this._spacing);

      const [_minWidth, _minHeight,
        naturalWidth, naturalHeight] = children[i].get_preferred_size();

      childBox.set_origin(
        Math.floor(x),
        Math.floor(y)
      );

      childBox.set_size(
        Math.max(childSize, naturalWidth),
        Math.max(childSize, naturalHeight)
      );

      children[i].allocate(childBox);
    }
  }

  _getMinChildSize(children) {
    let minWidth = 0;
    let minHeight = 0;

    children.forEach(child => {
      const childMinHeight = child.get_preferred_height(-1)[0];
      const childMinWidth = child.get_preferred_width(-1)[0];

      minWidth = Math.max(minWidth, childMinWidth);
      minHeight = Math.max(minHeight, childMinHeight);
    });

    return Math.max(minWidth, minHeight);
  }

  _getPrimaryAxisCount(children) {
    if (children.length === 0) {
      return 0;
    }

    return this._reserveColumns
      ? this._columns
      : Math.min(children.length, this._columns);
  }

  _getSecondaryAxisCount(children) {
    if (children.length === 0) {
      return 0;
    }

    return Math.ceil(children.length / this._columns);
  }

  _getAxisSize(count, childSize) {
    if (count === 0) {
      return 0;
    }

    return count * childSize + (count - 1) * this._spacing;
  }

  destroy() {
    this._settings.disconnectObject(this);
  }
});
