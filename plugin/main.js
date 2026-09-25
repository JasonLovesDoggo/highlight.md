"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/plugin/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => AiHighlightPlugin
});
module.exports = __toCommonJS(main_exports);
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var import_obsidian = require("obsidian");

// src/annotations.ts
function parseHighlightData(value) {
  const empty = { mode: "markdown", annotations: [] };
  if (typeof value !== "object" || value === null) return empty;
  const mode = "mode" in value && value.mode === "overlay" ? "overlay" : "markdown";
  if (!("annotations" in value) || !Array.isArray(value.annotations)) {
    return { mode, annotations: [] };
  }
  const annotations = [];
  for (const item of value.annotations) {
    if (typeof item !== "object" || item === null) continue;
    if (!("id" in item) || typeof item.id !== "string") continue;
    if (!("path" in item) || typeof item.path !== "string") continue;
    if (!("quote" in item) || typeof item.quote !== "string" || item.quote.length === 0) continue;
    if (!("prefix" in item) || typeof item.prefix !== "string") continue;
    if (!("suffix" in item) || typeof item.suffix !== "string") continue;
    if (!("offset" in item) || typeof item.offset !== "number" || !Number.isSafeInteger(item.offset) || item.offset < 0) continue;
    if (!("comment" in item) || typeof item.comment !== "string") continue;
    if (!("createdAt" in item) || typeof item.createdAt !== "string") continue;
    annotations.push({
      id: item.id,
      path: item.path,
      quote: item.quote,
      prefix: item.prefix,
      suffix: item.suffix,
      offset: item.offset,
      comment: item.comment,
      createdAt: item.createdAt
    });
  }
  return { mode, annotations };
}
function createAnnotation(path, contents, offset, quote, comment = "") {
  return {
    id: crypto.randomUUID(),
    path,
    quote,
    prefix: contents.slice(Math.max(0, offset - 40), offset),
    suffix: contents.slice(offset + quote.length, offset + quote.length + 40),
    offset,
    comment,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function locateAnnotation(contents, annotation) {
  const candidates = [];
  let position = 0;
  while (position <= contents.length - annotation.quote.length) {
    const offset = contents.indexOf(annotation.quote, position);
    if (offset === -1) break;
    let context = 0;
    for (let index = 1; index <= annotation.prefix.length; index++) {
      if (contents[offset - index] !== annotation.prefix[annotation.prefix.length - index]) break;
      context++;
    }
    for (let index = 0; index < annotation.suffix.length; index++) {
      if (contents[offset + annotation.quote.length + index] !== annotation.suffix[index]) break;
      context++;
    }
    candidates.push({ offset, context });
    position = offset + annotation.quote.length;
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].offset;
  const best = Math.max(...candidates.map((candidate) => candidate.context));
  const matching = candidates.filter((candidate) => candidate.context === best);
  if (matching.length === 1 && best > 0) return matching[0].offset;
  return null;
}

// src/markup.ts
function highlightMarkup(text) {
  if (!text.includes("=") && !/[&<>]/.test(text)) return `==${text}==`;
  const safeText = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<mark>${safeText}</mark>`;
}
function isHighlightAround(before, after) {
  return before === "==" && after === "==" || before === "<mark>" && after === "</mark>";
}

// src/plugin/main.ts
var refreshAnnotations = import_state.StateEffect.define();
var AiHighlightPlugin = class extends import_obsidian.Plugin {
  data = { mode: "markdown", annotations: [] };
  editors = /* @__PURE__ */ new Set();
  pendingSave = Promise.resolve();
  async onload() {
    this.data = parseHighlightData(await this.loadData());
    this.addSettingTab(new HighlightSettingsTab(this.app, this));
    this.registerEditorExtension(this.annotationExtension());
    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selected text",
      editorCallback: (editor, context) => {
        void this.highlightSelection(editor, context.file?.path);
      }
    });
    this.addCommand({
      id: "comment-selection",
      name: "Comment on selected text",
      editorCallback: (editor, context) => {
        const path = context.file?.path;
        const quote = editor.getSelection();
        if (!path || !quote) {
          new import_obsidian.Notice("Select text in a note first.");
          return;
        }
        const offset = editor.posToOffset(editor.getCursor("from"));
        new CommentModal(this.app, (comment) => {
          if (editor.getValue().slice(offset, offset + quote.length) !== quote) {
            new import_obsidian.Notice("The selected text changed. Select it again before commenting.");
            return;
          }
          void this.addAnnotation(path, editor.getValue(), offset, quote, comment);
        }).open();
      }
    });
    this.addCommand({
      id: "show-annotations",
      name: "Show annotations in current note",
      callback: () => {
        const path = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView)?.file?.path;
        if (!path) {
          new import_obsidian.Notice("Open a Markdown note first.");
          return;
        }
        new AnnotationsModal(this.app, this.data.annotations.filter((annotation) => annotation.path === path), (id) => {
          void this.removeAnnotation(id);
        }).open();
      }
    });
  }
  async onExternalSettingsChange() {
    await this.pendingSave;
    this.data = parseHighlightData(await this.loadData());
    this.refreshEditors();
  }
  get mode() {
    return this.data.mode;
  }
  async setMode(mode) {
    await this.updateData((data) => ({ ...data, mode }));
    new import_obsidian.Notice(`Highlight mode: ${mode === "overlay" ? "Annotations" : "Markdown"}`);
  }
  async highlightSelection(editor, path) {
    const quote = editor.getSelection();
    if (!quote) {
      new import_obsidian.Notice("Select text first, then run Highlight selected text.");
      return;
    }
    if (this.data.mode === "overlay") {
      if (!path) {
        new import_obsidian.Notice("Open a Markdown note before highlighting.");
        return;
      }
      await this.addAnnotation(path, editor.getValue(), editor.posToOffset(editor.getCursor("from")), quote);
      return;
    }
    if (quote.includes("\n") || quote.includes("\r")) {
      new import_obsidian.Notice("Markdown highlights must stay on one line. Annotation mode supports multiple lines.");
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const lineBefore = editor.getLine(from.line);
    const lineAfter = editor.getLine(to.line);
    const beforeEquals = from.ch >= 2 ? lineBefore.slice(from.ch - 2, from.ch) : "";
    const beforeMark = from.ch >= 6 ? lineBefore.slice(from.ch - 6, from.ch) : "";
    const afterEquals = to.ch + 2 <= lineAfter.length ? lineAfter.slice(to.ch, to.ch + 2) : "";
    const afterMark = to.ch + 7 <= lineAfter.length ? lineAfter.slice(to.ch, to.ch + 7) : "";
    if (isHighlightAround(beforeEquals, afterEquals) || isHighlightAround(beforeMark, afterMark)) {
      new import_obsidian.Notice("That text is already highlighted.");
      return;
    }
    editor.replaceSelection(highlightMarkup(quote));
  }
  async addAnnotation(path, contents, offset, quote, comment = "") {
    try {
      const annotation = createAnnotation(path, contents, offset, quote, comment);
      if (locateAnnotation(contents, annotation) !== offset) {
        throw new Error("This selection cannot be anchored uniquely. Select a longer passage.");
      }
      await this.updateData((data) => {
        const exists = data.annotations.some((current) => current.path === path && current.quote === quote && locateAnnotation(contents, current) === offset);
        if (exists) throw new Error("That selection already has an annotation.");
        return { ...data, annotations: [...data.annotations, annotation] };
      });
      new import_obsidian.Notice(comment ? "Comment added." : "Annotation highlight added.");
    } catch (error) {
      new import_obsidian.Notice(error instanceof Error ? error.message : String(error));
    }
  }
  async removeAnnotation(id) {
    await this.updateData((data) => ({
      ...data,
      annotations: data.annotations.filter((annotation) => annotation.id !== id)
    }));
    new import_obsidian.Notice("Annotation removed.");
  }
  updateData(change) {
    const result = this.pendingSave.then(async () => {
      const updated = change(parseHighlightData(await this.loadData()));
      await this.saveData(updated);
      this.data = updated;
      this.refreshEditors();
    });
    this.pendingSave = result.catch(() => void 0);
    return result;
  }
  refreshEditors() {
    for (const editor of this.editors) editor.dispatch({ effects: refreshAnnotations.of(null) });
  }
  annotationExtension() {
    const owner = this;
    return import_view.ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        owner.editors.add(view);
        this.decorations = this.build();
      }
      view;
      decorations;
      update(update) {
        const oldPath = update.startState.field(import_obsidian.editorInfoField).file?.path;
        const newPath = update.state.field(import_obsidian.editorInfoField).file?.path;
        if (update.docChanged || oldPath !== newPath || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshAnnotations)))) {
          this.decorations = this.build();
        }
      }
      destroy() {
        owner.editors.delete(this.view);
      }
      build() {
        const path = this.view.state.field(import_obsidian.editorInfoField).file?.path;
        if (!path) return import_view.Decoration.none;
        const contents = this.view.state.doc.toString();
        const marks = owner.data.annotations.filter((annotation) => annotation.path === path).map((annotation) => owner.markFor(contents, annotation)).filter((mark) => mark !== null).sort((left, right) => left.from - right.from);
        return import_view.Decoration.set(marks);
      }
    }, { decorations: (plugin) => plugin.decorations });
  }
  markFor(contents, annotation) {
    const from = locateAnnotation(contents, annotation);
    if (from === null) return null;
    return import_view.Decoration.mark({
      class: "ai-highlight-annotation",
      attributes: { title: annotation.comment || "Annotation highlight" }
    }).range(from, from + annotation.quote.length);
  }
};
var HighlightSettingsTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, owner) {
    super(app, owner);
    this.owner = owner;
  }
  owner;
  display() {
    this.containerEl.empty();
    new import_obsidian.Setting(this.containerEl).setName("Highlight mode").setDesc("Markdown changes the note. Annotations are stored in the plugin data and drawn over the editor.").addDropdown((dropdown) => dropdown.addOption("markdown", "Markdown markup").addOption("overlay", "Annotations (no note changes)").setValue(this.owner.mode).onChange((value) => {
      if (value === "markdown" || value === "overlay") void this.owner.setMode(value);
    }));
  }
};
var CommentModal = class extends import_obsidian.Modal {
  constructor(app, submit) {
    super(app);
    this.submit = submit;
  }
  submit;
  onOpen() {
    this.setTitle("Comment on selection");
    let comment = "";
    new import_obsidian.Setting(this.contentEl).addTextArea((input) => input.setPlaceholder("Write a comment").onChange((value) => {
      comment = value;
    }));
    new import_obsidian.Setting(this.contentEl).addButton((button) => button.setButtonText("Add comment").setCta().onClick(() => {
      if (!comment.trim()) return;
      this.close();
      this.submit(comment.trim());
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var AnnotationsModal = class extends import_obsidian.Modal {
  constructor(app, annotations, remove) {
    super(app);
    this.annotations = annotations;
    this.remove = remove;
  }
  annotations;
  remove;
  onOpen() {
    this.setTitle("Annotations in this note");
    if (this.annotations.length === 0) {
      this.contentEl.createEl("p", { text: "No annotations in this note." });
      return;
    }
    for (const annotation of this.annotations) {
      new import_obsidian.Setting(this.contentEl).setName(annotation.quote.slice(0, 100)).setDesc(annotation.comment || "Highlight").addButton((button) => button.setButtonText("Remove").onClick(() => {
        this.remove(annotation.id);
        this.close();
      }));
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
