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
var import_obsidian = require("obsidian");

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
var AiHighlightPlugin = class extends import_obsidian.Plugin {
  onload() {
    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selected text",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (selection.length === 0) {
          new import_obsidian.Notice("Select text first, then run Highlight selected text.");
          return;
        }
        if (selection.includes("\n") || selection.includes("\r")) {
          new import_obsidian.Notice("Highlight one line at a time.");
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
        editor.replaceSelection(highlightMarkup(selection));
      }
    });
  }
};
