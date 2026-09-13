const EYE_OPEN_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export interface PasswordInputOptions {
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  className?: string;
  value?: string;
  required?: boolean;
  maxLength?: number;
  filterAlphanumericOnly?: boolean;
}

export function createPasswordInputWithEye(options: PasswordInputOptions = {}): {
  wrapper: HTMLElement;
  input: HTMLInputElement;
  toggleBtn: HTMLButtonElement;
} {
  const wrapper = document.createElement("div");
  wrapper.className = "password-input-wrapper";

  const input = document.createElement("input");
  input.type = "password";
  if (options.id) input.id = options.id;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.autocomplete) input.autocomplete = options.autocomplete as AutoFill;
  if (options.className) input.className = options.className;
  if (options.value) input.value = options.value;
  if (options.required) input.required = true;
  if (options.maxLength) input.maxLength = options.maxLength;

  if (options.filterAlphanumericOnly) {
    input.addEventListener("input", () => {
      // Allow only alphanumeric characters, strictly preserving case
      input.value = input.value.replace(/[^a-zA-Z0-9]/g, "");
    });
  }

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "password-eye-btn";
  toggleBtn.setAttribute("aria-label", "Toggle password visibility");
  toggleBtn.innerHTML = EYE_CLOSED_SVG;

  let isVisible = false;
  toggleBtn.addEventListener("click", () => {
    isVisible = !isVisible;
    input.type = isVisible ? "text" : "password";
    toggleBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    input.focus();
  });

  wrapper.appendChild(input);
  wrapper.appendChild(toggleBtn);

  return { wrapper, input, toggleBtn };
}
