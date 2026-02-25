const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Конфигурация
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = '7533802502';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Приветствие и регистрация
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || 'unknown';

    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

    if (!user) {
        await supabase.from('users').insert({
            id: userId,
            username: username,
            balance_ton: 0,
            balance_rub: 0,
            created_at: new Date()
        });
        
        bot.sendMessage(chatId, 
            `🪓 Добро пожаловать в TimberTON!\n\n` +
            `Играй и зарабатывай TON и рубли.\n` +
            `Минимальная ставка: 0.5 TON / 50 ₽\n\n` +
            `Нажми "🎮 Играть" чтобы начать!`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎮 Играть', web_app: { url: process.env.WEBAPP_URL } }
                    ], [
                        { text: '💰 Пополнить', callback_data: 'deposit' },
                        { text: '💸 Вывести', callback_data: 'withdraw' }
                    ]]
                }
            }
        );
    } else {
        bot.sendMessage(chatId, `С возвращением, @${username}!`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🎮 Играть', web_app: { url: process.env.WEBAPP_URL } }
                ]]
            }
        });
    }
});

// Пополнение
bot.onText(/\/deposit/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `💳 Выберите валюту для пополнения:\n\n` +
        `💎 TON — минимум 1 TON\n` +
        `₽ Рубли — минимум 100 ₽ (СБП)`,
        {
            reply_markup: {
                inline_keyboard: [[
                    { text: '💎 Пополнить TON', callback_data: 'deposit_ton' }
                ], [
                    { text: '₽ Пополнить рубли', callback_data: 'deposit_rub' }
                ]]
            }
        }
    );
});

// Обработка callback
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data === 'deposit_rub') {
        const paymentId = `SBP_${userId}_${Date.now()}`;
        
        await supabase.from('deposits').insert({
            payment_id: paymentId,
            user_id: userId,
            amount: 0,
            currency: 'rub',
            method: 'sbp',
            status: 'pending'
        });

        bot.sendMessage(chatId,
            `💳 Пополнение рублей через СБП\n\n` +
            `📱 Номер: <code>+7 (994) 140-23-39</code>\n` +
            `🏦 Банк: OZON Банк (СБП)\n\n` +
            `1️⃣ Отправьте от 100 ₽ по СБП\n` +
            `2️⃣ В комментарии ОБЯЗАТЕЛЬНО:\n` +
            `<code>${paymentId}</code>\n\n` +
            `3️⃣ Нажмите "✅ Я оплатил"`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Я оплатил', callback_data: `check_${paymentId}` }
                    ]]
                }
            }
        );
    }

    if (data.startsWith('check_')) {
        bot.sendMessage(chatId, '⏳ Проверяем платёж... Обычно 5-15 минут');
        bot.sendMessage(ADMIN_ID, 
            `🔔 Новый платёж на проверку!\n` +
            `ID: ${data}\n` +
            `Пользователь: @${query.from.username}\n` +
            `Проверьте админ-панель`
        );
    }

    if (data === 'withdraw') {
        bot.sendMessage(chatId, 
            `💸 Вывод средств\n\n` +
            `Минимум: 5 TON / 500 ₽\n` +
            `Комиссия: 0%`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '💎 Вывести TON', callback_data: 'withdraw_ton' }
                    ], [
                        { text: '₽ Вывести рубли', callback_data: 'withdraw_rub' }
                    ]]
                }
            }
        );
    }

    bot.answerCallbackQuery(query.id);
});

// API для Mini App
app.post('/api/game/start', async (req, res) => {
    const { user_id, bet, currency } = req.body;
    
    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('id', user_id)
        .single();

    const balanceField = currency === 'ton' ? 'balance_ton' : 'balance_rub';
    
    if (!user || user[balanceField] < bet) {
        return res.json({ error: 'Insufficient balance' });
    }

    await supabase.rpc('decrement_balance', {
        user_id: user_id,
        amount: bet,
        field: balanceField
    });

    const { data: game } = await supabase.from('games').insert({
        user_id: user_id,
        bet: bet,
        currency: currency,
        score: 0,
        status: 'playing',
        created_at: new Date()
    }).select().single();

    res.json({ game_id: game.id, balance: user[balanceField] - bet });
});

app.post('/api/game/end', async (req, res) => {
    const { game_id, score, win } = req.body;
    
    const { data: game } = await supabase
        .from('games')
        .select('*')
        .eq('id', game_id)
        .single();

    if (win) {
        const prize = game.bet * 2;
        const balanceField = game.currency === 'ton' ? 'balance_ton' : 'balance_rub';
        
        await supabase.rpc('increment_balance', {
            user_id: game.user_id,
            amount: prize,
            field: balanceField
        });
    }

    await supabase.from('games').update({
        score: score,
        status: win ? 'won' : 'lost',
        finished_at: new Date()
    }).eq('id', game_id);

    res.json({ success: true });
});

app.get('/api/user/:id', async (req, res) => {
    const { data: user } = await supabase
        .from('users')
        .select('balance_ton, balance_rub, username')
        .eq('id', req.params.id)
        .single();
    
    res.json(user);
});

// Админ API
app.get('/api/admin/stats', async (req, res) => {
    const { data: deposits } = await supabase
        .from('deposits')
        .select('*')
        .eq('status', 'pending');
    
    const { data: withdrawals } = await supabase
        .from('withdrawals')
        .select('*')
        .eq('status', 'pending');

    res.json({
        pending_deposits: deposits || [],
        pending_withdrawals: withdrawals || []
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
