export interface UpdateToastText {
  message: string;
  restart: string;
  later: string;
}

export class UpdateToast {
  private el: HTMLElement | null = null;

  constructor(private readonly host: HTMLElement = document.body) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  show(text: UpdateToastText, onRestart: () => void): void {
    this.close();
    const el = document.createElement("div");
    el.className = "toast update-toast";
    el.setAttribute("role", "status");
    const message = document.createElement("span");
    message.className = "update-toast-text";
    message.textContent = text.message;
    const later = document.createElement("button");
    later.type = "button";
    later.className = "btn btn-ghost btn-sm";
    later.textContent = text.later;
    later.addEventListener("click", () => this.close());
    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "btn btn-primary btn-sm";
    restart.textContent = text.restart;
    restart.addEventListener("click", () => {
      this.close();
      onRestart();
    });
    el.append(message, later, restart);
    this.host.appendChild(el);
    this.el = el;
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }
}
