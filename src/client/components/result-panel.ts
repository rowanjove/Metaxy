import QRCode from "qrcode";
import { t, formatDateTime, formatRemainingTime } from "../i18n";
import type { CommitDropData } from "../../shared/contracts";

export function createResultPanel(data: CommitDropData, onReset: () => void): HTMLElement {
  const container = document.createElement("section");
  container.className = "pane-card result-pane";

  const resultBox = document.createElement("div");
  resultBox.className = "result-box";

  const title = document.createElement("h2");
  title.className = "result-title";
  title.textContent = t("result.successTitle");

  // Code Card
  const codeCard = document.createElement("div");
  codeCard.className = "result-code-card";

  const codeLabel = document.createElement("span");
  codeLabel.className = "form-label";
  codeLabel.textContent = t("result.codeLabel");

  const codeText = document.createElement("div");
  codeText.className = "result-code";
  codeText.textContent = data.code;

  const expiryText = document.createElement("div");
  expiryText.className = "result-expiry";
  const remainingSecs = Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000));
  expiryText.textContent = t("result.expiresAt", {
    time: formatDateTime(data.expiresAt),
    remaining: formatRemainingTime(remainingSecs)
  });

  codeCard.appendChild(codeLabel);
  codeCard.appendChild(codeText);
  codeCard.appendChild(expiryText);

  // Buttons Row
  const btnRow = document.createElement("div");
  btnRow.className = "result-btn-row";

  const copyCodeBtn = document.createElement("button");
  copyCodeBtn.type = "button";
  copyCodeBtn.className = "btn btn-primary";
  copyCodeBtn.textContent = t("result.copyCode");

  copyCodeBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.code);
      copyCodeBtn.textContent = t("result.copiedCode");
      setTimeout(() => {
        copyCodeBtn.textContent = t("result.copyCode");
      }, 2000);
    } catch {
      // Fallback
    }
  });

  const copyLinkBtn = document.createElement("button");
  copyLinkBtn.type = "button";
  copyLinkBtn.className = "btn btn-secondary";
  copyLinkBtn.textContent = t("result.copyLink");

  copyLinkBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.url);
      copyLinkBtn.textContent = t("result.copiedLink");
      setTimeout(() => {
        copyLinkBtn.textContent = t("result.copyLink");
      }, 2000);
    } catch {
      // Fallback
    }
  });

  const sendAnotherBtn = document.createElement("button");
  sendAnotherBtn.type = "button";
  sendAnotherBtn.className = "btn btn-ghost";
  sendAnotherBtn.textContent = t("result.sendAnother");
  sendAnotherBtn.addEventListener("click", onReset);

  btnRow.appendChild(copyCodeBtn);
  btnRow.appendChild(copyLinkBtn);
  btnRow.appendChild(sendAnotherBtn);

  // QR Code Canvas
  const qrWrapper = document.createElement("div");
  qrWrapper.className = "qr-wrapper";

  const qrTitle = document.createElement("span");
  qrTitle.className = "form-label";
  qrTitle.textContent = t("result.qrCodeTitle");

  const canvas = document.createElement("canvas");
  canvas.className = "qr-canvas";

  QRCode.toCanvas(canvas, data.url, {
    width: 140,
    margin: 1,
    color: {
      dark: "#000000",
      light: "#FFFFFF"
    }
  }).catch((err) => {
    console.error("[QRCode] Failed to render canvas", err);
  });

  qrWrapper.appendChild(qrTitle);
  qrWrapper.appendChild(canvas);

  resultBox.appendChild(title);
  resultBox.appendChild(codeCard);
  resultBox.appendChild(btnRow);
  resultBox.appendChild(qrWrapper);
  container.appendChild(resultBox);

  return container;
}
