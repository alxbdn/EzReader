/** The quick look card on the opening screen: shown wherever quick look with Space exists (Windows). */
export async function showQuickLookCard(
  state: () => Promise<{ available: boolean }>,
  card: HTMLElement | null = document.getElementById("welcome-quick-look"),
): Promise<void> {
  if (!card) return;
  try {
    card.hidden = !(await state()).available;
  } catch {
    card.hidden = true;
  }
}
