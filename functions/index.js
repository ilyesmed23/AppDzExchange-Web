const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Resend } = require("resend");
const { defineSecret } = require("firebase-functions/params");
const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");

admin.initializeApp();

// Doit correspondre a la constante ADMIN utilisee dans admin.html
const ADMIN_EMAIL = "giftformenow@gmail.com";
const SITE_URL = "https://appdzexchange.com";
const SENDER = "AppDz Exchange <noreply@appdzexchange.com>";

/**
 * Supprime DEFINITIVEMENT un utilisateur : son compte Firebase Authentication
 * (ce que le client ne peut pas faire lui-meme pour un autre utilisateur)
 * ET sa fiche Firestore. Reserve a l'administrateur.
 */
exports.deleteUserAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Reserve a l'administrateur."
    );
  }

  const uid = data && data.uid;
  if (!uid || typeof uid !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "uid manquant.");
  }
  if (uid === context.auth.uid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Impossible de supprimer son propre compte admin."
    );
  }

  await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
  await admin.auth().deleteUser(uid);
  return { ok: true };
});

/* ──────────────────────────────────────────────────────────────────────
 * Notifications email aux UTILISATEURS (nouveau message ticket, changement
 * de statut d'un transfert), envoyees via Resend (service tiers gratuit)
 * depuis noreply@appdzexchange.com — l'utilisateur ne voit jamais l'email
 * gmail personnel de l'admin.
 * La cle API Resend est stockee dans Secret Manager (jamais dans le code) :
 *   firebase functions:secrets:set RESEND_API_KEY
 * ────────────────────────────────────────────────────────────────────── */

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

let _resend = null;
function getResend() {
  if (!_resend) {
    _resend = new Resend(RESEND_API_KEY.value());
  }
  return _resend;
}

// Echappe le texte saisi par un utilisateur avant de l'inserer dans un email HTML.
function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Anti-spam du chat : au plus 1 email par ticket toutes les 5 minutes
// (les messages suivants restent visibles dans l'espace admin / client),
// et plus aucun email de chat si le quota Resend du jour est presque atteint
// (on garde de la marge pour les emails de transfert).
const CHAT_MAIL_COOLDOWN_MS = 5 * 60 * 1000;
const CHAT_DAILY_LIMIT = 80;

async function chatMailAllowed(ticketRef, ticket, field) {
  try {
    const last = ticket[field] && ticket[field].toMillis ? ticket[field].toMillis() : 0;
    if (last && Date.now() - last < CHAT_MAIL_COOLDOWN_MS) return false;
    const u = await admin.firestore().collection("config").doc("resendUsage").get();
    if (u.exists) {
      const d = u.data();
      const now = new Date();
      const dayKey = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
      if (d.currentDay === dayKey && (d.sentToday || 0) >= CHAT_DAILY_LIMIT) return false;
    }
    await ticketRef.update({ [field]: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    console.error("chatMailAllowed error:", e);
    return true;
  }
}

// Petit gabarit HTML sobre, aux couleurs du site, avec un bouton vers l'espace perso.
// Le detail (montant, motif, message complet, etc.) n'est jamais inclus dans l'email :
// on incite l'utilisateur a se connecter sur son espace pour le consulter.
function renderEmailHtml(lang, title, message) {
  const isAr = lang === "ar";
  const dir = isAr ? "rtl" : "ltr";
  const align = isAr ? "right" : "left";
  const btnLabel = isAr ? "الدخول إلى مساحتي الشخصية" : "Accéder à mon espace";
  const footer = isAr
    ? "AppDz Exchange — هذه رسالة آلية، الرجاء عدم الرد عليها."
    : "AppDz Exchange — Ceci est un message automatique, merci de ne pas y répondre.";
  return (
    '<div dir="' + dir + '" style="direction:' + dir + ';text-align:' + align + ';' +
    'font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;' +
    'background:#f4f6fb;padding:24px;border-radius:12px;">' +
      '<div style="background:#ffffff;border-radius:10px;padding:24px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.06);">' +
        '<h2 style="margin:0 0 12px;color:#1a2b4c;font-size:20px;">' + title + "</h2>" +
        '<p style="margin:0 0 20px;color:#3a4356;font-size:15px;line-height:1.6;">' + message + "</p>" +
        '<a href="' + SITE_URL + '/auth.html" target="_blank" style="display:inline-block;' +
        "background:#1a56db;color:#ffffff;text-decoration:none;padding:12px 24px;" +
        'border-radius:8px;font-size:15px;font-weight:bold;">' + btnLabel + "</a>" +
      "</div>" +
      '<p style="margin:16px 0 0;color:#8a92a6;font-size:12px;">' + footer + "</p>" +
    "</div>"
  );
}

// Compteur d'envois Resend (jour + mois), pour suivre le forfait gratuit
// (100/jour, 3000/mois) depuis l'interface admin. Se reinitialise tout seul
// quand on change de jour/mois.
async function incrementResendCounter() {
  try {
    var now = new Date();
    var monthKey = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    var dayKey = monthKey + "-" + String(now.getUTCDate()).padStart(2, "0");
    var ref = admin.firestore().collection("config").doc("resendUsage");
    await admin.firestore().runTransaction(async (tx) => {
      var snap = await tx.get(ref);
      var data = snap.exists ? snap.data() : {};
      var sentMonth = (data.currentMonth === monthKey) ? (data.sentThisMonth || 0) + 1 : 1;
      var sentDay = (data.currentDay === dayKey) ? (data.sentToday || 0) + 1 : 1;
      var sentTotal = (data.sentTotal || 0) + 1;
      tx.set(ref, {
        sentTotal: sentTotal,
        sentThisMonth: sentMonth,
        currentMonth: monthKey,
        sentToday: sentDay,
        currentDay: dayKey,
        lastUpdated: now
      }, { merge: true });
    });
  } catch (e) {
    console.error("incrementResendCounter error:", e);
  }
}

async function sendUserNotification(to, lang, subject, title, message) {
  if (!to) return;
  try {
    const result = await getResend().emails.send({
      from: SENDER,
      to: to,
      subject: subject,
      html: renderEmailHtml(lang, title, message)
    });
    if (result && result.error) {
      console.error("sendUserNotification error:", result.error);
    } else {
      await incrementResendCounter();
    }
  } catch (e) {
    console.error("sendUserNotification error:", e);
  }
}

// Textes bilingues pour chaque changement de statut de transfert.
// {nom} est remplace par le prenom/nom de l'utilisateur.
const TRANSFER_NOTICES = {
  approuvee: {
    fr: { subject: "Votre demande de transfert est acceptée ✅", title: "Demande acceptée",
      msg: "Bonjour {nom}, votre demande de transfert a été acceptée. Vous pouvez maintenant effectuer le virement et envoyer votre preuve depuis votre espace personnel." },
    ar: { subject: "تمت الموافقة على طلب التحويل ✅", title: "تمت الموافقة على الطلب",
      msg: "مرحباً {nom}، تمت الموافقة على طلب التحويل الخاص بك. يمكنك الآن إجراء التحويل وإرسال الإثبات من مساحتك الشخصية." }
  },
  terminee: {
    fr: { subject: "Votre transfert est terminé 🏁", title: "Transfert terminé",
      msg: "Bonjour {nom}, votre transfert a été finalisé. Connectez-vous à votre espace personnel pour consulter la preuve de paiement." },
    ar: { subject: "تم إنهاء تحويلك 🏁", title: "تم إنهاء التحويل",
      msg: "مرحباً {nom}، تم إنهاء عملية التحويل الخاصة بك. يرجى الدخول إلى مساحتك الشخصية للاطلاع على إثبات الدفع." }
  },
  rejetee: {
    fr: { subject: "Votre transfert a été rejeté ❌", title: "Transfert rejeté",
      msg: "Bonjour {nom}, votre demande de transfert a été rejetée. Connectez-vous à votre espace personnel pour connaître le motif." },
    ar: { subject: "تم رفض تحويلك ❌", title: "تم رفض التحويل",
      msg: "مرحباً {nom}، تم رفض طلب التحويل الخاص بك. يرجى الدخول إلى مساحتك الشخصية لمعرفة السبب." }
  },
  manque_info: {
    fr: { subject: "Information manquante sur votre transfert ⚠️", title: "Information manquante",
      msg: "Bonjour {nom}, il manque une information pour traiter votre transfert. Connectez-vous à votre espace personnel pour voir ce qui est demandé." },
    ar: { subject: "معلومات ناقصة بخصوص تحويلك ⚠️", title: "معلومات ناقصة",
      msg: "مرحباً {nom}، هناك معلومة ناقصة لمعالجة تحويلك. يرجى الدخول إلى مساحتك الشخصية لمعرفة المطلوب." }
  },
  annulee: {
    fr: { subject: "Votre transfert a été annulé 🚫", title: "Transfert annulé",
      msg: "Bonjour {nom}, votre transfert a été annulé. Connectez-vous à votre espace personnel pour plus de détails." },
    ar: { subject: "تم إلغاء تحويلك 🚫", title: "تم إلغاء التحويل",
      msg: "مرحباً {nom}، تم إلغاء تحويلك. يرجى الدخول إلى مساحتك الشخصية لمزيد من التفاصيل." }
  },
};

// Se declenche a chaque mise a jour d'un document transferts/{txId}.
// N'envoie un email que si le champ "statut" a reellement change et que
// le nouveau statut fait partie de la liste ci-dessus.
exports.onTransferStatusChanged = onDocumentUpdated(
  { document: "transferts/{txId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!before || !after) return;
    if (before.statut === after.statut) return;

    // a_valider -> en_attente = l'admin vient d'autoriser la demande
    const noticeKey = (before.statut === "a_valider" && after.statut === "en_attente")
      ? "approuvee" : after.statut;
    const notice = TRANSFER_NOTICES[noticeKey];
    if (!notice) return;

    let lang = "fr";
    try {
      if (after.userId) {
        const uSnap = await admin.firestore().collection("users").doc(after.userId).get();
        if (uSnap.exists && uSnap.data().lang) lang = uSnap.data().lang;
      }
    } catch (e) {
      console.error("lookup lang error:", e);
    }

    const t = notice[lang] || notice.fr;
    const nom = escapeHtml(after.nomUser || after.nom || "");
    const to = after.email || "";
    await sendUserNotification(
      to, lang, t.subject, t.title, t.msg.replace("{nom}", nom)
    );
  }
);

// Se declenche a chaque nouveau message dans tickets/{ticketId}/messages.
// N'envoie un email que lorsque c'est l'ADMIN qui repond (from === 'admin'),
// pour ne pas notifier l'utilisateur de ses propres messages.
exports.onTicketAdminReply = onDocumentCreated(
  { document: "tickets/{ticketId}/messages/{msgId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const msg = event.data.data();
    if (!msg || msg.from !== "admin") return;

    const ticketId = event.params.ticketId;
    const ticketRef = admin.firestore().collection("tickets").doc(ticketId);
    let ticket = null;
    try {
      const tSnap = await ticketRef.get();
      if (!tSnap.exists) return;
      ticket = tSnap.data();
    } catch (e) {
      console.error("ticket lookup error:", e);
      return;
    }
    if (!(await chatMailAllowed(ticketRef, ticket, "lastUserMailAt"))) return;

    let lang = "fr";
    try {
      if (ticket.userId) {
        const uSnap = await admin.firestore().collection("users").doc(ticket.userId).get();
        if (uSnap.exists && uSnap.data().lang) lang = uSnap.data().lang;
      }
    } catch (e) {
      console.error("lookup lang error:", e);
    }

    const nom = escapeHtml(ticket.nom || "");
    const objet = escapeHtml(ticket.objet || "");
    const to = ticket.email || "";
    const texts = {
      fr: { subject: "Nouvelle réponse à votre ticket 💬", title: "Nouvelle réponse",
        msg: "Bonjour " + nom + ", vous avez reçu une nouvelle réponse concernant votre ticket « " + objet + " ». Connectez-vous à votre espace personnel pour la lire." },
      ar: { subject: "رد جديد على تذكرتك 💬", title: "رد جديد",
        msg: "مرحباً " + nom + "، وصلك رد جديد بخصوص تذكرتك « " + objet + " ». يرجى الدخول إلى مساحتك الشخصية لقراءته." }
    };
    const t = texts[lang] || texts.fr;
    await sendUserNotification(to, lang, t.subject, t.title, t.msg);
  }
);

/* 
 * Notifications email a l'ADMIN (nouvelle inscription, nouvelle demande de
 * transfert, nouveau message dans un ticket), via Resend. Remplace les
 * notifications EmailJS front-end equivalentes (front-end retire cote
 * auth.html / app.html).
 *  */

function renderAdminEmailHtml(title, message) {
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;' +
    'background:#f4f6fb;padding:24px;border-radius:12px;">' +
      '<div style="background:#ffffff;border-radius:10px;padding:24px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.06);">' +
        '<h2 style="margin:0 0 12px;color:#1a2b4c;font-size:20px;">' + escapeHtml(title) + "</h2>" +
        '<p style="margin:0 0 20px;color:#3a4356;font-size:14px;line-height:1.7;white-space:pre-line;">' + escapeHtml(message) + "</p>" +
        '<a href="' + SITE_URL + '/admin.html" target="_blank" style="display:inline-block;' +
        "background:#1a56db;color:#ffffff;text-decoration:none;padding:12px 24px;" +
        'border-radius:8px;font-size:15px;font-weight:bold;">Ouvrir l\'espace admin</a>' +
      "</div>" +
    "</div>"
  );
}

async function sendAdminNotification(subject, title, message) {
  try {
    const result = await getResend().emails.send({
      from: SENDER,
      to: ADMIN_EMAIL,
      subject: subject,
      html: renderAdminEmailHtml(title, message)
    });
    if (result && result.error) {
      console.error("sendAdminNotification error:", result.error);
    } else {
      await incrementResendCounter();
    }
  } catch (e) {
    console.error("sendAdminNotification error:", e);
  }
}

// Notifie l'ADMIN qu'un nouvel utilisateur vient de s'inscrire.
exports.onNewUserRegistered = onDocumentCreated(
  { document: "users/{uid}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const u = event.data.data();
    if (!u) return;
    const details =
      "Nom : " + (u.nom || "") + "\n" +
      "Email : " + (u.email || "") + "\n" +
      "Email Paysera : " + (u.emailPaysera || "") + "\n" +
      "CCP : " + (u.ccp || "");
    await sendAdminNotification(" Nouvelle inscription", "Nouvelle inscription", details);
  }
);

// Notifie l'ADMIN d'une nouvelle demande de transfert.
exports.onNewTransferRequest = onDocumentCreated(
  { document: "transferts/{txId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const tx = event.data.data();
    if (!tx) return;
    const details =
      "Nom : " + (tx.nomUser || "") + "\n" +
      "Email : " + (tx.email || "") + "\n" +
      "CCP : " + (tx.ccpUser || "") + "\n" +
      "Email Paysera : " + (tx.emailPaysera || "") + "\n" +
      "Montant : " + (tx.montantEur || "") + " EUR (" + (tx.montantDzd || "") + " DZD, taux " + (tx.taux || "") + ")";
    await sendAdminNotification("Nouvelle demande de transfert à valider", "Nouvelle demande à valider", details);
  }
);

// Notifie l'ADMIN d'un nouveau message utilisateur dans un ticket
// (nouveau ticket ou reponse a un ticket existant).
exports.onTicketUserMessage = onDocumentCreated(
  { document: "tickets/{ticketId}/messages/{msgId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const msg = event.data.data();
    if (!msg || msg.from !== "user") return;

    const ticketId = event.params.ticketId;
    const ticketRef = admin.firestore().collection("tickets").doc(ticketId);
    let ticket = null;
    try {
      const tSnap = await ticketRef.get();
      if (!tSnap.exists) return;
      ticket = tSnap.data();
    } catch (e) {
      console.error("ticket lookup error:", e);
      return;
    }
    if (!(await chatMailAllowed(ticketRef, ticket, "lastAdminMailAt"))) return;

    const details =
      "De : " + (ticket.nom || "") + "\n" +
      "Email : " + (ticket.email || "") + "\n" +
      (ticket.objet ? "Objet : " + ticket.objet + "\n" : "") +
      "Message : " + (msg.text || (msg.fileName ? "(fichier joint : " + msg.fileName + ")" : ""));

    await sendAdminNotification(" Nouveau message ticket support", "Nouveau message ticket", details);
  }
);

// Permet a l'admin de corriger manuellement le compteur Resend (jour/mois)
// apres avoir verifie le vrai total sur resend.com/dashboard/emails.
exports.setResendUsage = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError("permission-denied", "Reserve a l'administrateur.");
  }
  var now = new Date();
  var monthKey = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
  var dayKey = monthKey + "-" + String(now.getUTCDate()).padStart(2, "0");
  var update = { lastUpdated: now };
  var sentToday = Number(data && data.sentToday);
  var sentThisMonth = Number(data && data.sentThisMonth);
  if (!isNaN(sentToday)) { update.sentToday = sentToday; update.currentDay = dayKey; }
  if (!isNaN(sentThisMonth)) { update.sentThisMonth = sentThisMonth; update.currentMonth = monthKey; }
  await admin.firestore().collection("config").doc("resendUsage").set(update, { merge: true });
  return { ok: true };
});
