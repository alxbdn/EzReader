export interface WidgetData {
  subtype: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: string | string[] | null;
  hidden?: boolean;
  readOnly?: boolean;
  rect: [number, number, number, number];
  multiLine?: boolean;
  comb?: boolean;
  maxLen?: number;
  textAlignment?: number;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  combo?: boolean;
  options?: Array<{ exportValue: string; displayValue: string }>;
  defaultAppearanceData?: { fontSize?: number; fontColor?: ArrayLike<number> };
  alternativeText?: string;
}

export interface FieldBox { left: number; top: number; width: number; height: number }

const OFF = "Off";

function firstValue(v: WidgetData["fieldValue"]): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export function fieldFontSize(a: WidgetData, box: FieldBox, scale: number): number {
  const own = a.defaultAppearanceData?.fontSize ?? 0;
  if (own > 0) return Math.max(own * scale, 6);
  if (a.multiLine) return Math.max(Math.min(12 * scale, box.height * 0.8), 6);
  return Math.max(Math.min(box.height * 0.65, 14 * scale), 6);
}

function cssColor(c: ArrayLike<number> | undefined): string | null {
  if (!c || c.length < 3) return null;
  const [r, g, b] = [c[0], c[1], c[2]];
  return r === 0 && g === 0 && b === 0 ? null : `rgb(${r}, ${g}, ${b})`;
}

export function createFieldControl(
  a: WidgetData,
  box: FieldBox,
  scale: number,
  stored: string | undefined,
  onChange: (name: string, value: string) => void,
): HTMLElement | null {
  if (a.subtype !== "Widget" || a.hidden || a.readOnly) return null;
  const name = a.fieldName ?? "";
  if (!name) return null;

  let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

  if (a.fieldType === "Tx") {
    const value = stored ?? firstValue(a.fieldValue);
    const size = fieldFontSize(a, box, scale);
    if (a.multiLine) {
      const ta = document.createElement("textarea");
      ta.value = value;
      el = ta;
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = value;
      el = inp;
    }
    if (a.maxLen && a.maxLen > 0) (el as HTMLInputElement).maxLength = a.maxLen;
    if (a.comb && a.maxLen && a.maxLen > 0) {
      const cell = box.width / a.maxLen;
      const glyph = size * 0.6;
      el.classList.add("comb");
      el.style.letterSpacing = `${Math.max(cell - glyph, 0)}px`;
      el.style.paddingLeft = `${Math.max((cell - glyph) / 2, 0)}px`;
      el.style.paddingRight = "0";
    }
    const align = ["left", "center", "right"][a.textAlignment ?? 0] ?? "left";
    if (align !== "left") el.style.textAlign = align;
    el.style.fontSize = `${size}px`;
    const color = cssColor(a.defaultAppearanceData?.fontColor);
    if (color) el.style.color = color;
    el.addEventListener("input", () => onChange(name, el.value));
  } else if (a.fieldType === "Btn" && (a.checkBox || a.radioButton)) {
    const inp = document.createElement("input");
    if (a.checkBox) {
      const on = a.exportValue || "Yes";
      const current = stored ?? firstValue(a.fieldValue);
      inp.type = "checkbox";
      inp.checked = current === on || current === "true";
      inp.addEventListener("change", () => onChange(name, inp.checked ? on : "false"));
    } else {
      const on = a.buttonValue ?? "";
      const current = stored ?? firstValue(a.fieldValue);
      inp.type = "radio";
      inp.name = name;
      inp.value = on;
      inp.checked = !!on && on !== OFF && current === on;
      inp.addEventListener("change", () => { if (inp.checked) onChange(name, on); });
    }
    el = inp;
  } else if (a.fieldType === "Ch") {
    const sel = document.createElement("select");
    const value = stored ?? firstValue(a.fieldValue);
    const opts = a.options ?? [];
    if (!a.combo) sel.size = Math.max(2, Math.min(opts.length, Math.floor(box.height / Math.max(fieldFontSize(a, box, scale) * 1.25, 1)) || 2));
    let matched = false;
    for (const opt of opts) {
      const option = document.createElement("option");
      option.value = opt.exportValue;
      option.textContent = opt.displayValue;
      if (opt.exportValue === value) { option.selected = true; matched = true; }
      sel.appendChild(option);
    }
    if (!matched) sel.selectedIndex = -1;
    sel.style.fontSize = `${fieldFontSize({ ...a, multiLine: false }, { ...box, height: Math.min(box.height, 24 * scale) }, scale)}px`;
    sel.addEventListener("change", () => onChange(name, sel.value));
    el = sel;
  } else {
    return null;
  }

  el.classList.add("form-field");
  if (a.alternativeText) {
    el.title = a.alternativeText;
    el.setAttribute("aria-label", a.alternativeText);
  } else {
    el.setAttribute("aria-label", name);
  }
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  return el;
}
