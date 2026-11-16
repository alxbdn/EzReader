// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createFieldControl, fieldFontSize, type WidgetData } from "../form-fields";

const box = { left: 10, top: 20, width: 200, height: 20 };
const widget = (a: Partial<WidgetData>): WidgetData => ({ subtype: "Widget", fieldName: "f", rect: [0, 0, 1, 1], ...a });

describe("form field controls", () => {
  it("text field: keeps the stored value, sends what is typed", () => {
    const onChange = vi.fn();
    const el = createFieldControl(widget({ fieldType: "Tx", fieldValue: "Dupont", maxLen: 10 }), box, 1, undefined, onChange) as HTMLInputElement;
    expect(el.value).toBe("Dupont");
    expect(el.maxLength).toBe(10);
    expect(el.style.left).toBe("10px");
    el.value = "Élodie";
    el.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenCalledWith("f", "Élodie");
    const again = createFieldControl(widget({ fieldType: "Tx", fieldValue: "Dupont" }), box, 1, "Élodie", vi.fn()) as HTMLInputElement;
    expect(again.value).toBe("Élodie");
  });

  it("uses the form's own font size and alignment", () => {
    const a = widget({ fieldType: "Tx", textAlignment: 2, defaultAppearanceData: { fontSize: 10, fontColor: [0, 0, 255] } });
    const el = createFieldControl(a, box, 1.5, undefined, vi.fn())!;
    expect(el.style.fontSize).toBe("15px");
    expect(el.style.textAlign).toBe("right");
    expect(el.style.color).toBe("rgb(0, 0, 255)");
    expect(fieldFontSize(widget({ multiLine: true }), { ...box, height: 200 }, 1)).toBe(12);
  });

  it("check box sends its own on state", () => {
    const onChange = vi.fn();
    const el = createFieldControl(widget({ fieldType: "Btn", checkBox: true, exportValue: "Oui", fieldValue: "Off" }), box, 1, undefined, onChange) as HTMLInputElement;
    expect(el.checked).toBe(false);
    el.checked = true;
    el.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith("f", "Oui");
    el.checked = false;
    el.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith("f", "false");
  });

  it("radio buttons use the widget's state, not true", () => {
    const onChange = vi.fn();
    const m = createFieldControl(widget({ fieldType: "Btn", radioButton: true, buttonValue: "m", fieldValue: "m" }), box, 1, undefined, onChange) as HTMLInputElement;
    const mme = createFieldControl(widget({ fieldType: "Btn", radioButton: true, buttonValue: "mme", fieldValue: "m" }), box, 1, undefined, onChange) as HTMLInputElement;
    expect(m.checked).toBe(true);
    expect(mme.checked).toBe(false);
    mme.checked = true;
    mme.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith("f", "mme");
  });

  it("combo box shows the value pdf.js gives as a list", () => {
    const options = [{ exportValue: "FR", displayValue: "France" }, { exportValue: "BE", displayValue: "Belgique" }];
    const sel = createFieldControl(widget({ fieldType: "Ch", combo: true, options, fieldValue: ["BE"] }), box, 1, undefined, vi.fn()) as HTMLSelectElement;
    expect(sel.value).toBe("BE");
    const empty = createFieldControl(widget({ fieldType: "Ch", combo: true, options, fieldValue: [] }), box, 1, undefined, vi.fn()) as HTMLSelectElement;
    expect(empty.selectedIndex).toBe(-1);
    const list = createFieldControl(widget({ fieldType: "Ch", combo: false, options }), { ...box, height: 70 }, 1, undefined, vi.fn()) as HTMLSelectElement;
    expect(list.size).toBe(2);
  });

  it("leaves out push buttons, read-only and hidden fields", () => {
    expect(createFieldControl(widget({ fieldType: "Btn", pushButton: true }), box, 1, undefined, vi.fn())).toBeNull();
    expect(createFieldControl(widget({ fieldType: "Tx", readOnly: true }), box, 1, undefined, vi.fn())).toBeNull();
    expect(createFieldControl(widget({ fieldType: "Tx", hidden: true }), box, 1, undefined, vi.fn())).toBeNull();
    expect(createFieldControl(widget({ fieldType: "Sig" }), box, 1, undefined, vi.fn())).toBeNull();
  });
});
