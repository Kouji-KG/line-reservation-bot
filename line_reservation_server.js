const express = require('express');
const line = require('@line/bot-sdk');
const app = express();

// LINE Messaging APIの設定（後で実際の値に置き換える）
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN',
  channelSecret: process.env.CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET'
};

const client = new line.Client(config);

// 予約データを保存（本番環境ではデータベースを使用）
const reservations = [];
const userStates = {}; // ユーザーの入力状態を管理

// 機器の数
const EQUIPMENT_COUNT = 15;

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const userMessage = event.message.text.trim();

  // ユーザーの状態を確認
  if (!userStates[userId]) {
    userStates[userId] = { step: 'idle' };
  }

  let replyMessage = '';

  // コマンド処理
  if (userMessage === '予約' || userMessage === '予約する') {
    userStates[userId] = { step: 'equipment', data: {} };
    replyMessage = '予約を開始します。\n\n機器番号を入力してください（1-15）:';
  } 
  else if (userMessage === '予約確認' || userMessage === '確認') {
    replyMessage = getReservationList();
  }
  else if (userMessage === 'キャンセル' || userMessage === '予約キャンセル') {
    userStates[userId] = { step: 'cancel', data: {} };
    replyMessage = 'キャンセルする予約番号を入力してください:\n\n' + getUserReservations(userId);
  }
  else if (userMessage === 'ヘルプ' || userMessage === 'help') {
    replyMessage = getHelpMessage();
  }
  // 予約フロー中の処理
  else {
    replyMessage = handleReservationFlow(userId, userMessage);
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyMessage
  });
}

function handleReservationFlow(userId, message) {
  const state = userStates[userId];

  switch (state.step) {
    case 'equipment':
      const equipmentNum = parseInt(message);
      if (isNaN(equipmentNum) || equipmentNum < 1 || equipmentNum > EQUIPMENT_COUNT) {
        return `機器番号は1-${EQUIPMENT_COUNT}の数字で入力してください。`;
      }
      state.data.equipment = equipmentNum;
      state.step = 'startTime';
      return '開始日時を入力してください。\n例: 2024/12/25 14:00';

    case 'startTime':
      const startTime = parseDateTime(message);
      if (!startTime) {
        return '日時の形式が正しくありません。\n例: 2024/12/25 14:00';
      }
      if (startTime < new Date()) {
        return '過去の日時は指定できません。';
      }
      state.data.startTime = startTime;
      state.step = 'endTime';
      return '終了予定日時を入力してください。\n例: 2024/12/25 16:00';

    case 'endTime':
      const endTime = parseDateTime(message);
      if (!endTime) {
        return '日時の形式が正しくありません。\n例: 2024/12/25 16:00';
      }
      if (endTime <= state.data.startTime) {
        return '終了日時は開始日時より後に設定してください。';
      }

      // 予約の重複チェック
      const conflict = checkConflict(state.data.equipment, state.data.startTime, endTime);
      if (conflict) {
        state.step = 'idle';
        return `❌ 予約失敗\n\nその時間帯は既に予約されています。\n\n${getEquipmentSchedule(state.data.equipment)}`;
      }

      // 予約を保存
      const reservation = {
        id: reservations.length + 1,
        userId: userId,
        equipment: state.data.equipment,
        startTime: state.data.startTime,
        endTime: endTime,
        createdAt: new Date()
      };
      reservations.push(reservation);
      state.step = 'idle';

      return `✅ 予約完了\n\n予約番号: ${reservation.id}\n機器: ${reservation.equipment}号機\n開始: ${formatDateTime(reservation.startTime)}\n終了: ${formatDateTime(reservation.endTime)}`;

    case 'cancel':
      const cancelId = parseInt(message);
      const idx = reservations.findIndex(r => r.id === cancelId && r.userId === userId);
      if (idx === -1) {
        state.step = 'idle';
        return '指定された予約が見つかりません。';
      }
      const canceled = reservations.splice(idx, 1)[0];
      state.step = 'idle';
      return `✅ キャンセル完了\n\n予約番号: ${canceled.id}\n機器: ${canceled.equipment}号機`;

    default:
      return getHelpMessage();
  }
}

function checkConflict(equipment, startTime, endTime) {
  return reservations.some(r => 
    r.equipment === equipment &&
    ((startTime >= r.startTime && startTime < r.endTime) ||
     (endTime > r.startTime && endTime <= r.endTime) ||
     (startTime <= r.startTime && endTime >= r.endTime))
  );
}

function getReservationList() {
  if (reservations.length === 0) {
    return '現在予約はありません。';
  }

  const now = new Date();
  const activeReservations = reservations
    .filter(r => r.endTime > now)
    .sort((a, b) => a.startTime - b.startTime);

  if (activeReservations.length === 0) {
    return '現在有効な予約はありません。';
  }

  let message = '📋 予約一覧\n\n';
  activeReservations.forEach(r => {
    message += `[${r.id}] 機器${r.equipment}号機\n`;
    message += `${formatDateTime(r.startTime)} - ${formatTime(r.endTime)}\n\n`;
  });

  return message;
}

function getUserReservations(userId) {
  const userReservations = reservations.filter(r => r.userId === userId);
  
  if (userReservations.length === 0) {
    return 'あなたの予約はありません。';
  }

  let message = '';
  userReservations.forEach(r => {
    message += `[${r.id}] 機器${r.equipment}号機\n`;
    message += `${formatDateTime(r.startTime)} - ${formatTime(r.endTime)}\n\n`;
  });

  return message;
}

function getEquipmentSchedule(equipment) {
  const schedule = reservations
    .filter(r => r.equipment === equipment && r.endTime > new Date())
    .sort((a, b) => a.startTime - b.startTime);

  if (schedule.length === 0) {
    return `機器${equipment}号機は現在空いています。`;
  }

  let message = `機器${equipment}号機の予約状況:\n\n`;
  schedule.forEach(r => {
    message += `${formatDateTime(r.startTime)} - ${formatTime(r.endTime)}\n`;
  });

  return message;
}

function getHelpMessage() {
  return `📱 予約システム ヘルプ

【コマンド一覧】
・予約 → 新規予約
・予約確認 → 全予約表示
・キャンセル → 予約取消
・ヘルプ → このメッセージ

【使い方】
1. "予約"と送信
2. 機器番号(1-15)を入力
3. 開始日時を入力
4. 終了日時を入力

【日時入力例】
2024/12/25 14:00
2024-12-25 14:00
12/25 14:00`;
}

function parseDateTime(str) {
  // 様々な日時形式に対応
  const patterns = [
    /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{2})/,
    /(\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{2})/
  ];

  for (const pattern of patterns) {
    const match = str.match(pattern);
    if (match) {
      if (match.length === 6) {
        // YYYY/MM/DD HH:MM
        return new Date(match[1], match[2] - 1, match[3], match[4], match[5]);
      } else if (match.length === 5) {
        // MM/DD HH:MM
        const now = new Date();
        return new Date(now.getFullYear(), match[1] - 1, match[2], match[3], match[4]);
      }
    }
  }
  return null;
}

function formatDateTime(date) {
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});