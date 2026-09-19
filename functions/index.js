const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// Doit correspondre a la constante ADMIN utilisee dans admin.html
const ADMIN_EMAIL = "giftformenow@gmail.com";

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

  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw new functions.https.HttpsError("internal", e.message);
    }
  }

  await admin.firestore().collection("users").doc(uid).delete();

  return { success: true };
});
