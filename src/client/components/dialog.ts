export function showImageLightbox(src: string, alt: string = "Preview"): void {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.tabIndex = -1;

  const content = document.createElement("div");
  content.className = "dialog-content";
  content.setAttribute("role", "dialog");
  content.setAttribute("aria-modal", "true");
  content.setAttribute("aria-label", alt);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dialog-close";
  closeButton.setAttribute("aria-label", "Close preview");
  closeButton.textContent = "×";

  const img = document.createElement("img");
  img.className = "dialog-img";
  img.src = src;
  img.alt = alt;

  content.appendChild(closeButton);
  content.appendChild(img);
  backdrop.appendChild(content);
  document.body.appendChild(backdrop);

  const prevActiveElement = document.activeElement as HTMLElement | null;

  const closeDialog = () => {
    document.removeEventListener("keydown", onKeyDown);
    backdrop.remove();
    prevActiveElement?.focus();
  };

  closeButton.addEventListener("click", closeDialog);
  closeButton.focus();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeDialog();
    }
  };

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      closeDialog();
    }
  });

  document.addEventListener("keydown", onKeyDown);
}
