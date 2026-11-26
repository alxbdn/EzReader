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
