const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");

admin.initializeApp();

exports.syncSolarData = onValueWritten("/", async (event) => {

    const data = event.data.after.val();

    if (!data) {
        return;
    }

    await admin.firestore()
        .collection("solar")
        .doc("latest")
        .set({
            battvol: data.battvol,
            command_switch: data.command_switch,
            cpu: data.cpu,
            invertervolt: data.invertervolt,
            mem: data.mem,
            solarcur: data.solarcur,
            solarvolt: data.solarvolt,
            status_switch: data.status_switch,
            uptime: data.uptime,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

    console.log("Solar data synchronized.");
});
