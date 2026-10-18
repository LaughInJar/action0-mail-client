const en = {
  title: (sender: string) => `Unsubscribe from ${sender}?`,
  oneClick: (sender: string) =>
    `${sender} will be asked to stop sending you mail. This can’t be undone.`,
  byMail: (address: string) =>
    `An unsubscribe request will be mailed from your address to ${address}. This can’t be undone.`,
  byPage: (sender: string, host: string) =>
    `${sender}’s unsubscribe page (${host}) opens in a new tab, where you finish unsubscribing.`,
  confirm: "Unsubscribe",
  openPage: "Open page",
  pageOpened: (sender: string) => `Opened the unsubscribe page of ${sender}`,
  working: (sender: string) => `Unsubscribing from ${sender}…`,
  done: (sender: string) => `Unsubscribed from ${sender}`,
  mailSent: (address: string) => `Unsubscribe mail sent to ${address}`,
  notAutomatic: (sender: string) =>
    `Couldn’t unsubscribe from ${sender} automatically.`,
  openTheirPage: "Open their page",
  failed: (sender: string, why: string) =>
    `Couldn’t unsubscribe from ${sender}: ${why}`,
};

const de: typeof en = {
  title: (sender) => `${sender} abbestellen?`,
  oneClick: (sender) =>
    `${sender} wird gebeten, dir keine E-Mails mehr zu schicken. Das lässt sich nicht rückgängig machen.`,
  byMail: (address) =>
    `Von deiner Adresse geht eine Abbestellung per E-Mail an ${address}. Das lässt sich nicht rückgängig machen.`,
  byPage: (sender, host) =>
    `Die Abbestell-Seite von ${sender} (${host}) öffnet sich in einem neuen Tab, dort schließt du das Abbestellen ab.`,
  confirm: "Abbestellen",
  openPage: "Seite öffnen",
  pageOpened: (sender) => `Abbestell-Seite von ${sender} geöffnet`,
  working: (sender) => `${sender} wird abbestellt …`,
  done: (sender) => `${sender} abbestellt`,
  mailSent: (address) => `Abbestellung an ${address} gesendet`,
  notAutomatic: (sender) =>
    `${sender} ließ sich nicht automatisch abbestellen.`,
  openTheirPage: "Ihre Seite öffnen",
  failed: (sender, why) => `${sender} ließ sich nicht abbestellen: ${why}`,
};

export const unsubscribe = { en, de };
