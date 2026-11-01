import type { MailTemplate } from "../../compose/templates";

/** Templates the demo starts with, so the picker can be tried right away. */
export const DEMO_TEMPLATES: readonly MailTemplate[] = [
  {
    id: "demo-thanks",
    name: "Thanks, I'll get back to you",
    subject: "",
    html: "<p>Hi {first name},</p><p>thanks for your message! I'll look into it and get back to you by the end of the week.</p>",
  },
  {
    id: "demo-follow-up",
    name: "Meeting follow-up",
    subject: "Follow-up on our meeting",
    html: "<p>Hi {first name},</p><p>thanks for your time today. As discussed, the next steps are:</p><ul><li><p>…</p></li></ul>",
  },
];
