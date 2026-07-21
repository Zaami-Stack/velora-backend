const nodemailer = require("nodemailer");

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

const FROM = process.env.SMTP_FROM || "Velora <noreply@velora.ma>";

async function sendOrderConfirmation(order, items) {
  if (!transporter) {
    console.log("[Email] No SMTP configured, skipping order confirmation for", order.id);
    return;
  }

  const email = order.customerEmail || order.shipping_address?.email;
  if (!email) return;

  const itemRows = items
    .map((i) => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${i.name}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${i.quantity}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${Number(i.price).toFixed(2)} DH</td></tr>`)
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#111;text-align:center">Order Confirmed</h2>
      <p style="color:#666;font-size:14px">Thank you for your order!</p>
      <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#333"><strong>Order ID:</strong> ${order.id}</p>
        <p style="margin:4px 0 0;font-size:14px;color:#333"><strong>Status:</strong> ${order.status}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:20px 0">
        <thead><tr style="background:#111;color:#fff"><th style="padding:10px;text-align:left">Item</th><th style="padding:10px;text-align:center">Qty</th><th style="padding:10px;text-align:right">Price</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div style="border-top:2px solid #111;padding-top:12px;margin-top:12px">
        <p style="font-size:14px;color:#333">Subtotal: <strong>${Number(order.subtotal).toFixed(2)} DH</strong></p>
        <p style="font-size:14px;color:#333">Shipping: <strong>${Number(order.shipping) === 0 ? "Free" : Number(order.shipping).toFixed(2) + " DH"}</strong></p>
        <p style="font-size:16px;color:#111"><strong>Total: ${Number(order.total).toFixed(2)} DH</strong></p>
      </div>
      <p style="color:#999;font-size:12px;text-align:center;margin-top:30px">Velora - Luxury Fashion</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: FROM,
      to: email,
      subject: `Order ${order.id} Confirmed - Velora`,
      html,
    });
    console.log("[Email] Order confirmation sent to", email, "for order", order.id);
  } catch (err) {
    console.error("[Email] Failed to send:", err.message);
  }
}

async function sendStatusUpdate(order, oldStatus, newStatus) {
  if (!transporter) return;

  const email = order.customerEmail || order.shipping_address?.email;
  if (!email) return;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#111;text-align:center">Order Status Updated</h2>
      <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#333"><strong>Order ID:</strong> ${order.id}</p>
        <p style="margin:4px 0 0;font-size:14px;color:#333"><strong>Status:</strong> <span style="color:#059669">${newStatus}</span></p>
      </div>
      <p style="color:#666;font-size:14px">Your order has been updated to <strong>${newStatus}</strong>.</p>
      <p style="color:#999;font-size:12px;text-align:center;margin-top:30px">Velora - Luxury Fashion</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: FROM,
      to: email,
      subject: `Order ${order.id} - ${newStatus} - Velora`,
      html,
    });
    console.log("[Email] Status update sent to", email, "for order", order.id);
  } catch (err) {
    console.error("[Email] Failed to send status update:", err.message);
  }
}

module.exports = { sendOrderConfirmation, sendStatusUpdate };
