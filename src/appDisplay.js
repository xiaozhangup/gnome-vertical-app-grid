import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SIDE_CONTROLS_ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/overviewControls.js';

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

    this._scrollView = new VerticalScrollView(settings);
    this.add_child(this._scrollView);

    this._sections = [];
    this._appIcons = [];
    this._groupColumnsBox = null;
    this._groupColumns = [];
    this._viewModeRow = null;
    this._viewModeSwitch = null;
    this._viewModeButtons = null;
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
      this._scrollView.scrollTo(0, false);
    }, this);

    // Update layout when settings change
    this._settings.connectObject('changed', (_, key) => {
      switch (key) {
        case 'app-sorting':
        case 'favorites-section':
        case 'favorites-sorting':
        case 'group-apps':
        case 'hidden-apps':
        case 'two-column-groups':
          this._updateViewModeSwitch(true);
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
      this._updateViewModeSwitch();
      return;
    }

    const row = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x_expand: false,
      y_expand: false
    });

    const actor = new St.BoxLayout({
      vertical: false,
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
      y_expand: false
    });

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
    this._updateViewModeSwitch();
  }

  _createViewModeButton(label, grouped) {
    const button = new St.Button({
      label,
      can_focus: true,
      reactive: true
    });

    button.connect('clicked', () => {
      this._settings.set_boolean('group-apps', grouped);
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
      'padding: 5px 12px;',
      'width: 66px;'
    ].join(' ');

    const inactiveStyle = [
      'background-color: transparent;',
      'border-radius: 999px;',
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

    if (!animate) {
      button.opacity = opacity;
      return;
    }

    button.ease({
      opacity,
      duration: 160,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD
    });
  }

  _addAppIcons() {
    const favSection = this._settings.get_boolean('favorites-section');
    const groupApps = this._settings.get_boolean('group-apps');
    const twoColumnGroups = this._settings.get_boolean('two-column-groups');
    const { favs, apps, allApps } = this._loadApps();

    this._hasFavoritesSection = groupApps && favSection && favs.length > 0;

    this._addViewModeSwitch();

    if (!groupApps) {
      const section = this._createSection(null);

      allApps.forEach(appInfo => this._addAppIcon(appInfo, section.view));
      this._updateLabelMargins();

      return;
    }

    if (this._hasFavoritesSection) {
      const section = this._createSection(_('Favorites'));

      favs.forEach(appInfo => this._addAppIcon(appInfo, section.view));
    }

    const groupedApps = this._groupApps(apps);
    const groupParents = this._getGroupSectionParents(groupedApps, twoColumnGroups);

    groupedApps.forEach(([initial, appInfos], index) => {
      const parent = groupParents[index];
      const section = this._createSection(initial, parent.actor, parent.key, parent.columnsScale);

      appInfos.forEach(appInfo => this._addAppIcon(appInfo, section.view));
    });

    this._updateLabelMargins();
  }

  _loadApps() {
    const installedApps = this._appSystem.get_installed();
    const hiddenApps = new Set(this._settings.get_strv('hidden-apps'));

    const favs = [];
    const apps = [];
    const allApps = [];

    // Filter out hidden apps and split off favorites
    const favSection = this._settings.get_boolean('favorites-section');

    installedApps.forEach(appInfo => { try {
      const appId = appInfo.get_id();
      const isFav = this._appFavorites.isFavorite(appId);

      if (!hiddenApps.has(appId) && this._parentalControls.shouldShowApp(appInfo)) {
        allApps.push(appInfo);

        if (favSection && isFav) {
          favs.push(appInfo);
        } else {
          apps.push(appInfo);
        }
      }
    } catch { } });

    // Sort favorites
    const favSorting = this._settings.get_string('favorites-sorting');
    const favIds = this._appFavorites._getIds();

    favs.sort((a, b) => {
      switch (favSorting) {
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
        case 'usage':
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': default:
          return compareAppNames(a, b);
      }
    };

    apps.sort(sortApps);
    allApps.sort(sortApps);

    return { favs, apps, allApps };
  }

  _createSection(title, parent = this._scrollView, parentKey = 'main', columnsScale = 1) {
    const actor = new St.BoxLayout({
      vertical: true,
      x_expand: false,
      y_expand: false
    });

    const label = title
      ? new St.Label({
        style_class: 'search-statustext',
        text: title
      })
      : null;

    const view = new St.Viewport({
      layout_manager: new VerticalLayout(this._settings, columnsScale)
    });

    const section = { actor, label, view, parentKey };

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

  _addAppIcon(appInfo, view) {
    const iconSize = this._settings.get_int('icon-size');
    const app = this._appSystem.lookup_app(appInfo.get_id());
    const appIcon = new AppDisplay.AppIcon(app, { isDraggable: false });

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

  _clearSections() {
    this._appIcons.forEach(appIcon => appIcon.destroy());

    this._sections.forEach(({ actor }) => {
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
    this._animateRedisplay(() => {
      this._redisplayLater = this._laters.add(Meta.LaterType.IDLE, () => {
        this._clearSections();

        this._addAppIcons();
        this._animateRedisplay();
      });
    });
  }

  _animateRedisplay(onComplete) {
    const actors = this._getRedisplayActors();

    if (actors.length === 0) {
      onComplete?.();
      return;
    }

    let pending = actors.length;

    actors.forEach(actor => {
      if (!onComplete) {
        actor.opacity = 0;
      }

      actor.ease({
        onComplete: onComplete
          ? () => {
            pending--;

            if (pending === 0) {
              onComplete();
            }
          }
          : null,
        opacity: onComplete ? 0 : 255,
        duration: SIDE_CONTROLS_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      });
    });
  }

  _getRedisplayActors() {
    return this._scrollView.getContentChildren()
      .filter(actor => actor !== this._viewModeRow);
  }

  _updateLabelMargins() {
    const spacing = this._settings.get_int('icon-spacing');
    const sectionKeys = new Set();

    if (this._viewModeSwitch) {
      this._viewModeSwitch.set_style([
        'background-color: rgba(255, 255, 255, 0.16);',
        'border-radius: 999px;',
        'padding: 4px;',
        'spacing: 4px;'
      ].join(' '));
    }

    if (this._viewModeRow) {
      this._viewModeRow.set_style(`margin: 0 0 ${spacing * 2}px 0;`);
    }

    this._sections.forEach(({ actor, label, parentKey }) => {
      const isFirstInParent = !sectionKeys.has(parentKey);
      const top = isFirstInParent ? 0 : spacing * 2;

      sectionKeys.add(parentKey);
      actor.set_style(`margin: ${top}px 0 0 0;`);

      if (label) {
        label.set_style(`margin: 0 0 ${spacing}px 0;`);
      }
    });

    if (this._groupColumnsBox) {
      const top = this._hasFavoritesSection ? spacing * 2 : 0;

      this._groupColumnsBox.set_style(`spacing: ${spacing}px; margin: ${top}px 0 0 0;`);
    }

    this._updateViewModeRowWidth();
  }

  _updateViewModeRowWidth() {
    if (!this._viewModeRow) {
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

    if (width > 0) {
      this._viewModeRow.set_width(width);
    }
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
      return Clutter.EVENT_PROPAGATE;
    }

    // Keyboard scroll
    const adjustment = this._scrollView.vadjustment;
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

    // Tab and arrow key navigation
    const navTarget = this._getNavTarget(focused, key);

    if (navTarget) {
      this._scrollView.scrollToChild(navTarget);
      navTarget.grab_key_focus();

      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _getNavTarget(focused, key) {
    const index = this._appIcons.indexOf(focused);
    const last = this._appIcons.length - 1;

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

    return this._appIcons[targetIndex];
  }

  destroy() {
    this._appSystem.disconnectObject(this);
    this._appFavorites.disconnectObject(this);
    this._parentalControls.disconnectObject(this);
    this._overview.disconnectObject(this);
    this._settings.disconnectObject(this);

    if (this._redisplayLater) {
      this._laters.remove(this._redisplayLater);
    }

    this._clearSections();

    super.destroy();
  }
});

const VerticalScrollView = GObject.registerClass(
class VerticalScrollView extends St.ScrollView {
  _init(settings) {
    this._settings = settings;

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
          top: 64,
          bottom: 64
        })
      }),
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.NEVER,
      x_expand: true,
      y_expand: true
    });

    this._scrollBox = new St.BoxLayout({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      vertical: true
    });

    this.set_child(this._scrollBox);
  }

  add_child(child) {
    this._scrollBox.add_child(child);
  }

  getContentChildren() {
    return this._scrollBox.get_children();
  }

  scrollToChild(child) {
    const childBox = child.get_allocation_box();

    // Get the child's vertical position inside the scroll view
    let actor = child;
    let childY = childBox.y1;

    while ((actor = actor.get_parent()) !== this) {
      childY += actor.get_allocation_box().y1;
    }

    // Scroll to keep the child vertically centered
    const adjustment = this.vadjustment;

    const childCenter = childY + childBox.get_height() / 2;
    const scroll = childCenter - adjustment.page_size / 2;

    this.scrollTo(scroll);
  }

  scrollTo(scroll, animate = true, duration = 200) {
    const now = GLib.get_monotonic_time();

    const adjustment = this.vadjustment;
    const anim = this._scrollAnim;

    // Only scroll if the clamped distance is greater than zero to prevent
    // rapidly retriggering the animation while holding down a key
    const min = adjustment.lower;
    const max = adjustment.upper - adjustment.page_size;

    const scrollClamped = Math.clamp(scroll, min, max);
    const distance = Math.abs(this.scroll - scrollClamped);

    if (distance === 0) {
      return Clutter.EVENT_STOP;
    }

    this._scroll = scrollClamped;

    if (animate) {
      // Init scroll animation
      anim.startTime = now;
      anim.startValue = adjustment.value;
      anim.delta = this.scroll - adjustment.value;

      if (anim.lock === null) {
        anim.lock = global.stage.connect('after-paint', this._scrollAnimationFrame.bind(this));
        anim.duration = duration * 1000;
      }
    } else {
      // Cancel running animation
      if (anim.lock) {
        anim.lock = global.stage.disconnect(anim.lock) || null;
      }

      adjustment.value = this.scroll;
    }

    // Redraw to trigger the next animation frame
    this.queue_redraw();

    return Clutter.EVENT_STOP;
  }

  _scrollAnimationFrame() {
    const now = GLib.get_monotonic_time();

    const adjustment = this.vadjustment;
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
    if (this._settings.get_boolean('animate-scroll')) {
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
    const adjustment = this.vadjustment;

    const direction = event.get_scroll_direction();
    const step = adjustment.page_size ** (2 / 3);

    let delta = 0;
    let animate = false;

    if (direction === Clutter.ScrollDirection.SMOOTH) {
      // Sometimes events without a smooth delta are emitted when using a
      // trackpad, so this debounce timestamp is used to prevent any sudden
      // jumps while scrolling
      this._trackpadTime = now;

      delta = event.get_scroll_delta()[Clutter.Orientation.VERTICAL] ?? 0;
    } else if (now - this._trackpadTime > 1000 * 1000) {
      if (direction === Clutter.ScrollDirection.UP) {
        delta = -1;
      } else if (direction === Clutter.ScrollDirection.DOWN) {
        delta = 1;
      }

      animate = true;
    }

    // Animate to the new scroll position
    const min = adjustment.lower;
    const max = adjustment.upper - adjustment.page_size;

    const clampedScroll = Math.clamp(this.scroll + delta * step, min, max);
    const distance = Math.abs(this.scroll - clampedScroll);
    const duration = (distance / 100) * 200;

    if (distance === 0) {
      return Clutter.EVENT_STOP;
    }

    return this.scrollTo(clampedScroll, animate, duration);
  }

  destroy() {
    if (this._scrollAnim.lock) {
      global.stage.disconnect(this._scrollAnim.lock);
    }
  }

  get scroll() {
    return this._scroll;
  }
});

const VerticalLayout = GObject.registerClass(
class VerticalLayout extends Clutter.LayoutManager {
  _init(settings, columnsScale = 1) {
    super._init();

    this._settings = settings;
    this._columnsScale = columnsScale;
    this._reserveColumns = columnsScale < 1;

    settings.connectObject('changed', (_, key) => {
      if (['columns', 'icon-spacing'].includes(key)) {
        this._columns = this._getColumns();
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

    const columns = this._reserveColumns
      ? this._columns
      : Math.min(children.length, this._columns);
    const size = columns * childSize + (columns - 1) * this._spacing;

    if (columns) {
      return [size, size];
    }

    return [0, 0];
  }

  vfunc_get_preferred_height(container, _forWidth) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const rows = Math.ceil(children.length / this._columns);
    const size = rows * childSize + (rows - 1) * this._spacing;

    if (rows) {
      return [size, size];
    }

    return [0, 0];
  }

  vfunc_allocate(container, _box) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const childBox = new Clutter.ActorBox();

    for (let i = 0; i < children.length; i++) {
      const col = i % this._columns;
      const row = Math.floor(i / this._columns);

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

  destroy() {
    this._settings.disconnectObject(this);
  }
});
