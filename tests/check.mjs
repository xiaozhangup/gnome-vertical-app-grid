import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { moveItem } from '../src/appOrder.js';

const order = ['a', 'b', 'c'];
assert.deepEqual(moveItem(order, 'a', 'c', true), ['b', 'c', 'a']);
assert.deepEqual(moveItem(order, 'c', 'a'), ['c', 'a', 'b']);
assert.deepEqual(moveItem(order, 'b'), ['a', 'c', 'b']);
assert.deepEqual(moveItem(order, 'folder', 'b'), ['a', 'folder', 'b', 'c']);
assert.deepEqual(moveItem(['a', 'b', 'a'], 'c', 'b'), ['a', 'c', 'b']);
assert.deepEqual(moveItem(order, 'a', 'a'), order);
assert.equal(moveItem(order, 'a', 'missing'), null);
assert.deepEqual(order, ['a', 'b', 'c']);

// Exercise the actual methods without starting or changing a GNOME session.
let keyFocus;
class Actor {
  constructor(params = {}) {
    Object.assign(this, { visible: true, can_focus: false, mapped: true }, params);
  }
  children = [];
  signals = {};
  add_child(child) { this.children.push(child); }
  get_children() { return this.children; }
  destroy_all_children() { this.children = []; }
  add_style_pseudo_class(name) { this.pseudoClass = name; }
  connect(signal, callback) { this.signals[signal] = callback; }
  set_style(style) { this.style = style; }
  set_width(width) { this.width = width; }
  set_pivot_point(x, y) { this.pivot = [x, y]; }
  get_preferred_width() { return [0, this.width ?? 0]; }
  remove_transition() { this.transition = null; }
  ease(params) {
    this.transition = { from: this.opacity, fromTranslation: this.translation_y, fromScale: this.scale_x, ...params };
  }
  grab_key_focus() { keyFocus = this; }
}

const source = readFileSync(new URL('../src/appDisplay.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
let now = 2000000;
const { VerticalAppDisplay, VerticalScrollView } = vm.runInNewContext(
  `Math.clamp = (n, min, max) => Math.min(max, Math.max(min, n));\n${source}\n({ VerticalAppDisplay, VerticalScrollView });`,
  {
    GObject: { registerClass: cls => cls },
    St: {
      Widget: Actor, ScrollView: Actor, BoxLayout: Actor, Button: Actor, Icon: Actor, Label: Actor, Viewport: Actor,
      ThemeContext: { get_for_stage: () => ({ scale_factor: 1 }) }
    },
    Clutter: {
      LayoutManager: class {}, BinLayout: class {}, GridLayout: class {}, EVENT_STOP: true,
      ActorAlign: { START: 0, CENTER: 1, END: 2 },
      AnimationMode: { EASE_OUT_QUAD: 0, EASE_OUT_CUBIC: 1 },
      KEY_Tab: 1, KEY_ISO_Left_Tab: 2,
      EventFlags: { FLAG_POINTER_EMULATED: 1 },
      Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
      ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4 }
    },
    GLib: { get_monotonic_time: () => now },
    Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    global: { stage: { connect: () => 1, disconnect: () => {} } },
    _: text => text
  });

for (const horizontal of [false, true]) {
  const view = Object.assign(Object.create(VerticalScrollView.prototype), {
    _horizontalScroll: horizontal,
    _scroll: 0, _trackpadTime: 0,
    _scrollAnim: { lock: null },
    _settings: { get_boolean: () => true },
    hadjustment: { value: 0, lower: 0, upper: 1000, page_size: 200 },
    vadjustment: { value: 0, lower: 0, upper: 1000, page_size: 200 },
    queue_redraw() {}
  });
  const adjustment = view.scrollAdjustment;
  view.scrollTo(180, false);
  assert.equal(adjustment.value, 180, 'Immediate scrolling must write the new position');
  view._animateScroll({
    get_flags: () => 0, get_scroll_direction: () => 4,
    get_scroll_delta: () => [0, 1]
  });
  assert.equal(adjustment.value, 180 + 200 ** (2 / 3), 'Touchpad and horizontal fallback must scroll');
  view.scrollTo(400, true);
  now += 200000;
  view._scrollAnimationFrame();
  assert.equal(adjustment.value, 400, 'Animated scrolling must reach its target');
  view.scrollTo(600, true);
  view.scrollTo(600, false);
  assert.equal(adjustment.value, 600, 'An immediate jump must finish an active animation');
  assert.equal(view._scrollAnim.lock, null);
  view.scrollTo(5000, false);
  assert.equal(adjustment.value, 800);

  const childBox = { x1: 300, y1: 300, get_width: () => 40, get_height: () => 40 };
  const parent = {
    get_allocation_box: () => ({ x1: 20, y1: 20 }),
    get_parent: () => view
  };
  const child = { get_allocation_box: () => childBox, get_parent: () => parent };
  view.scrollToChild(child, true);
  now += 200000;
  view._scrollAnimationFrame();
  assert.equal(adjustment.value, 256, 'Letter jumps leave 64 px before the target');
  view.scrollTo(600, true);
  view.scrollToChild(child, true, false);
  assert.equal(adjustment.value, 256, 'Position the letter target before the reveal animation');
  assert.equal(view._scrollAnim.lock, null, 'A letter jump cancels any previous scroll animation');
  view.scrollToChild(child);
  now += 200000;
  view._scrollAnimationFrame();
  assert.equal(adjustment.value, 240, 'Ordinary keyboard focus still centers the target');
  childBox.x1 = childBox.y1 = 0;
  view.scrollToChild(child, true);
  now += 200000;
  view._scrollAnimationFrame();
  assert.equal(adjustment.value, 0, 'The leading margin must not scroll past the start');
}

const grid = new Actor({ width: 600 });
let queuedScroll;
let groupedMode = true;
let horizontalMode = false;
let modeWrites = 0;
const display = Object.assign(Object.create(VerticalAppDisplay.prototype), {
  _letterPickerOpen: false,
  _settings: {
    get_boolean: key => key === 'group-apps' ? groupedMode : horizontalMode,
    set_boolean(key, value) {
      assert.equal(key, 'group-apps');
      groupedMode = value;
      modeWrites++;
      display._updateViewModeSwitch();
    }
  },
  _sections: [{ actor: grid }],
  _scrollView: new Actor({ scrollAdjustment: { value: 180 } }),
  _getRedisplayActors: () => [grid],
  _queueScroll: value => queuedScroll = value
});
display._addViewModeSwitch();
display._letterPicker.width = 452;
display._viewModeSwitch.width = 240;
display._updateViewModeRowWidth();
const letter = new Actor({ can_focus: true });
display._letterPicker.add_child(letter);
for (let i = 1; i < 9; i++) {
  display._letterPicker.add_child(new Actor({ can_focus: false }));
}
assert.deepEqual(display._viewModeRow.get_children(), [display._viewModeSwitch]);
assert.equal(display._viewModeSwitch.get_children().length, 2);
display._updateViewModeSwitch(true);
const modeTransition = display._viewModeButtons.grouped.transition;
display._addViewModeSwitch();
assert.equal(display._viewModeButtons.grouped.transition, modeTransition, 'Redisplay must not interrupt the mode fade');
display._viewModeButtons.grouped.signals.clicked();
assert.equal(modeWrites, 0, 'Clicking the active mode opens the picker without changing settings');
assert.equal(grid.visible, false);
assert.equal(display._letterPicker.visible, true);
assert.equal(display._viewModeRow.width, 600, 'Opening the picker must preserve the toolbar width');
assert.equal(queuedScroll, 0);
assert.equal(keyFocus, letter);
assert.equal(display._letterPicker.transition.from, 0, 'The picker must fade in');
assert.equal(display._letterPicker.transition.opacity, 255);
assert.ok(display._letterPicker.transition.duration > 0);
assert.equal(display._letterPicker.transition.fromScale, 0.97);
assert.equal(display._letterPicker.transition.scale_x, 1);
assert.equal(letter.transition.fromTranslation, 8);
assert.equal(letter.transition.translation_y, 0);
assert.equal(letter.transition.delay, 0);
assert.equal(display._letterPicker.get_children()[7].transition.delay, 16, 'Stagger the next row slightly');
assert.equal(display._getNavTarget(letter, 1), display._viewModeButtons.all, 'Skip disabled letters');
display._viewModeButtons.grouped.signals.clicked();
assert.equal(grid.visible, true);
assert.equal(display._letterPicker.visible, false);
assert.equal(display._viewModeRow.width, 600);
assert.equal(queuedScroll, 180);
assert.equal(keyFocus, display._viewModeButtons.grouped);
assert.equal(modeWrites, 0);
assert.equal(grid.transition.from, 0, 'Returning to apps must also fade in');
assert.equal(grid.transition.opacity, 255);
assert.equal(grid.transition.fromTranslation, 8);
assert.equal(grid.transition.translation_y, 0);
assert.equal(grid.transition.delay, 0, 'Returning to apps should respond immediately');

display._viewModeButtons.all.signals.clicked();
assert.equal(groupedMode, false);
assert.equal(display._letterPickerOpen, false, 'An inactive mode switches the view without opening the picker');
assert.equal(modeWrites, 1);
display._viewModeButtons.all.signals.clicked();
assert.equal(display._letterPickerOpen, true, 'Clicking active All opens the picker');
assert.equal(modeWrites, 1);
display._viewModeButtons.grouped.signals.clicked();
assert.equal(groupedMode, true);
assert.equal(display._letterPickerOpen, false, 'Changing modes closes an open picker');
assert.equal(keyFocus, display._viewModeButtons.grouped);
assert.equal(modeWrites, 2);

// Wide horizontal groups must not push the letter picker outside the viewport.
horizontalMode = true;
grid.width = 1600;
display._scrollView.width = 800;
display._updateViewModeRowWidth();
display._setLetterPickerOpen(true);
assert.equal(display._viewModeRow.width, 800);
display._setLetterPickerOpen(false);
assert.equal(display._viewModeRow.width, 1600);
horizontalMode = false;
grid.width = 600;
display._updateViewModeRowWidth();

// Reverse a transition before it finishes, then switch out of A-Z externally.
display._setLetterPickerOpen(true);
display._letterPicker.opacity = 100;
display._letterPicker.scale_x = 0.98;
letter.translation_y = 3;
display._setLetterPickerOpen(false);
display._setLetterPickerOpen(true);
assert.equal(display._letterPicker.transition.from, 0);
assert.equal(display._letterPicker.transition.fromScale, 0.97);
assert.equal(letter.transition.fromTranslation, 8, 'Rapid toggling resets motion as well as opacity');
assert.equal(display._letterPicker.visible, true);
assert.equal(grid.visible, false);
groupedMode = false;
display._updateViewModeSwitch();
assert.equal(display._letterPickerOpen, true, 'The picker remains available in All');
display._setLetterPickerOpen(false);
assert.equal(display._letterPickerOpen, false);
assert.equal(display._letterPicker.visible, false);
assert.equal(grid.visible, true);
assert.equal(keyFocus, display._viewModeButtons.all);
display._setLetterPickerOpen(true);
assert.equal(display._letterPickerOpen, true, 'The picker must open in All');
display._setLetterPickerOpen(false);

display._sections = [];
const favorites = display._createSection('Favorites');
const sectionA = display._createSection('A');
const sectionHash = display._createSection('#');
assert.equal(display._createSection(null).label, null);
assert.equal(favorites.label.can_focus, false);
assert.equal(sectionA.label.child.text, 'A');
assert.equal(sectionA.label.can_focus, true);
assert.equal(display._getNavTarget(null, 1), display._viewModeButtons.all);
groupedMode = true;
display._updateViewModeSwitch();
assert.equal(display._getNavTarget(display._viewModeButtons.grouped, 1), sectionA.label);
const app = new Actor({ can_focus: true });
sectionA.view.add_child(app);
assert.equal(display._getNavTarget(sectionA.label, 1), app);
assert.equal(display._getNavTarget(app, 2), sectionA.label);
for (const section of [sectionA, sectionHash]) {
  section.label.signals.clicked();
  assert.equal(display._letterPickerOpen, true, 'Group headings open the picker');
  display._setLetterPickerOpen(false);
}

// Restoring the All view is not a jump to its untitled section.
let beforeRedraw;
display._laters = { add: (_when, callback) => { beforeRedraw = callback; return 1; }, remove() {} };
display._sections = [{ title: null, label: null }];
display._appIcons = [];
display._jumpToInitial = null;
display._scrollView.scrollTo = value => queuedScroll = value;
VerticalAppDisplay.prototype._queueScroll.call(display, 180);
beforeRedraw();
assert.equal(queuedScroll, 180);

const sectionLabel = {};
let jumpedTo;
let jumpAlignStart;
let jumpAnimate;
display._sections = [{ title: 'A', label: sectionLabel, view: { get_first_child: () => null } }];
display._jumpToInitial = 'A';
display._scrollView.scrollToChild = (actor, alignStart, animate) => {
  jumpedTo = actor;
  jumpAlignStart = alignStart;
  jumpAnimate = animate;
};
VerticalAppDisplay.prototype._queueScroll.call(display, 0);
beforeRedraw();
assert.equal(jumpedTo, sectionLabel);
assert.equal(jumpAlignStart, true);
assert.equal(jumpAnimate, false);

// All uses the first matching icon in the existing order, including favorites and folders.
const allIcons = [
  new Actor({ id: 'zotero', name: 'Zotero', app: {} }),
  new Actor({ id: 'folder', name: '百度网盘' }),
  new Actor({ id: 'beta', name: 'Beta', app: {} }),
  new Actor({ id: 'numbers', name: '123 Tool', app: {} }),
  new Actor({ id: 'alpha', name: 'Alpha', app: {} })
];
const originalIds = allIcons.map(icon => icon.id);
groupedMode = false;
display._updateViewModeSwitch();
display._hasFavoritesSection = false;
display._appIcons = allIcons;
display._appFavorites = { isFavorite: id => id === 'zotero' };
display._sections = [{ title: null, label: null, actor: grid }];
display._letterPicker.layout_manager.attach = button => display._letterPicker.add_child(button);
display._queueScroll = VerticalAppDisplay.prototype._queueScroll;
display._updateLetterPicker();
const letterButton = initial => display._letterPicker.get_children().find(button => button.label === initial);
assert.equal(letterButton('Z').can_focus, true, 'Favorites must remain reachable by letter in All');
assert.equal(letterButton('C').can_focus, false);
assert.equal(letterButton('★'), undefined, 'All has no separate favorites section');
for (const [initial, target] of [['B', allIcons[1]], ['Z', allIcons[0]], ['#', allIcons[3]]]) {
  display._setLetterPickerOpen(true);
  letterButton(initial).signals.clicked();
  beforeRedraw();
  assert.equal(jumpedTo, target);
  assert.equal(jumpAlignStart, true);
  assert.equal(jumpAnimate, false, 'Reveal the destination instead of sweeping past unrelated apps');
  assert.equal(keyFocus, target, 'Use the same native focus selection as A-Z');
  assert.equal(display._letterPickerOpen, false);
  assert.equal(groupedMode, false, 'A letter jump must keep All mode');
  assert.deepEqual(allIcons.map(icon => icon.id), originalIds);
}
display._focusAppId = 'beta';
display._queueScroll(0);
beforeRedraw();
assert.equal(jumpedTo, allIcons[2]);
assert.equal(jumpAlignStart, false, 'Non-letter app selection keeps its centered scroll');
assert.equal(jumpAnimate, true);
groupedMode = true;
display._hasFavoritesSection = true;
display._updateLetterPicker();
assert.equal(letterButton('Z').can_focus, false);
assert.equal(letterButton('★').can_focus, true, 'A-Z retains its favorites shortcut');

const stockFolder = {};
const ownFolder = { visible: true, _verticalAppGridOwner: display };
let notifications = 0;
display._folderIcons = new Map([['own', ownFolder]]);
display.registerFolders({
  _folderIcons: [stockFolder], emit: signal => {
    assert.equal(signal, 'view-loaded');
    notifications++;
  }
});
display._publishFolders(false);
assert.equal(display._nativeAppDisplay._folderIcons.length, 2, 'Publishing must not duplicate icons');
assert.equal(notifications, 1);
display._unpublishFolders();
assert.equal(display._nativeAppDisplay._folderIcons.length, 1);
assert.equal(display._nativeAppDisplay._folderIcons[0], stockFolder);
console.log('Order, scrolling, letter picker, and folder observer checks passed.');
