// atlas-server/index.js

// 1. 환경변수 로드
require('dotenv').config();

// 2. 필요한 라이브러리 import
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

// Stripe API 키 설정
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 3. Express 앱 생성
const app = express();

// 4. 미들웨어 설정
app.use(express.json());
app.use(express.static('public'));

// 5. PostgreSQL 연결 설정
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 6. 데이터베이스 테이블 생성 함수
async function createTables() {
    try {
        // subscriptions 테이블
        await pool.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                stripe_customer_id VARCHAR(255) NOT NULL,
                stripe_subscription_id VARCHAR(255) NOT NULL,
                stripe_session_id VARCHAR(255) NOT NULL,
                customer_email VARCHAR(255) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'active',
                current_period_end TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        // subscription_wallets 테이블
        await pool.query(`
            CREATE TABLE IF NOT EXISTS subscription_wallets (
                id SERIAL PRIMARY KEY,
                subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
                wallet_address VARCHAR(255) NOT NULL,
                is_primary BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(subscription_id, wallet_address)
            )
        `);

        console.log('✅ 데이터베이스 테이블 생성 완료');
    } catch (error) {
        console.error('❌ 테이블 생성 오류:', error);
        throw error;
    }
}

// 7. Stripe 웹훅 처리
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.log(`❌ Webhook signature verification failed.`, err.message);
        return res.sendStatus(400);
    }
    
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log('✅ 결제가 성공적으로 완료되었습니다! Session ID:', session.id);
            await handleSubscriptionCreated(session);
            break;
        case 'customer.subscription.deleted':
            const subscription = event.data.object;
            console.log('❌ 구독이 취소되었습니다. Subscription ID:', subscription.id);
            await handleSubscriptionCancelled(subscription);
            break;
        default:
            console.log(`📝 처리되지 않은 이벤트 타입: ${event.type}`);
    }
    
    res.json({received: true});
});

// 8. 구독 생성 처리 함수
async function handleSubscriptionCreated(session) {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Stripe 구독 정보 가져오기
        const subscriptionId = session.subscription;
        const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // wallet_address 가져오기
        let walletAddress = stripeSubscription.metadata?.wallet_address;
        if (!walletAddress) {
            walletAddress = session.metadata?.wallet_address;
        }
        if (!walletAddress) {
            walletAddress = session.customer_details?.metadata?.wallet_address;
        }
        
        console.log('🔗 지갑 주소:', walletAddress);
        
        if (!walletAddress) {
            throw new Error('지갑 주소를 찾을 수 없습니다');
        }
        
        // 구독 정보 데이터베이스에 저장
        const currentPeriodEnd = stripeSubscription.current_period_end;
        let periodEndDate;
        
        if (currentPeriodEnd && !isNaN(currentPeriodEnd)) {
            periodEndDate = new Date(currentPeriodEnd * 1000);
        } else {
            // 기본값: 30일 후
            periodEndDate = new Date();
            periodEndDate.setDate(periodEndDate.getDate() + 30);
        }
        
        const result = await client.query(`
            INSERT INTO subscriptions (
                stripe_customer_id, 
                stripe_subscription_id, 
                stripe_session_id, 
                customer_email, 
                status, 
                current_period_end
            ) VALUES ($1, $2, $3, $4, $5, $6) 
            RETURNING id
        `, [
            stripeSubscription.customer,
            stripeSubscription.id,
            session.id,
            session.customer_details.email,
            stripeSubscription.status,
            periodEndDate
        ]);
        
        const dbSubscriptionId = result.rows[0].id;
        console.log('💾 구독 ID 저장됨:', dbSubscriptionId);
        
        // 지갑 주소 연결
        await client.query(`
            INSERT INTO subscription_wallets (
                subscription_id, 
                wallet_address, 
                is_primary
            ) VALUES ($1, $2, $3)
        `, [dbSubscriptionId, walletAddress, true]);
        
        console.log('🔗 지갑 주소 연결됨:', walletAddress);
        
        await client.query('COMMIT');
        console.log('✅ 구독 생성 및 지갑 연결 완료');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 구독 생성 오류:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 9. 구독 취소 처리 함수
async function handleSubscriptionCancelled(subscription) {
    try {
        await pool.query(`
            UPDATE subscriptions 
            SET status = 'cancelled', updated_at = NOW() 
            WHERE stripe_subscription_id = $1
        `, [subscription.id]);
        
        console.log('✅ 구독 취소 처리 완료');
    } catch (error) {
        console.error('❌ 구독 취소 처리 오류:', error);
        throw error;
    }
}

// 10. 일반적인 JSON 요청을 처리하기 위한 body parser
app.use(express.json());

// 11. API 엔드포인트들

// 구독 상태 확인 API
app.get('/api/subscription-status/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        
        const result = await pool.query(`
            SELECT s.* 
            FROM subscriptions s
            INNER JOIN subscription_wallets sw ON s.id = sw.subscription_id
            WHERE sw.wallet_address = $1 AND s.status = 'active'
            ORDER BY s.created_at DESC
            LIMIT 1
        `, [walletAddress]);
        
        if (result.rows.length > 0) {
            const subscription = result.rows[0];
            const now = new Date();
            const periodEnd = new Date(subscription.current_period_end);
            
            if (periodEnd > now) {
                res.json({
                    hasSubscription: true,
                    status: 'active',
                    expiresAt: subscription.current_period_end,
                    customerEmail: subscription.customer_email
                });
            } else {
                res.json({
                    hasSubscription: false,
                    status: 'expired',
                    message: '구독이 만료되었습니다'
                });
            }
        } else {
            res.json({
                hasSubscription: false,
                status: 'none',
                message: '구독이 없습니다'
            });
        }
    } catch (error) {
        console.error('❌ 구독 상태 확인 오류:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// 체인상 상태 확인 API
app.get('/api/onchain-status/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        
        // 여기에 블록체인 데이터 확인 로직 추가
        // 현재는 기본 응답만 반환
        res.json({
            walletAddress: walletAddress,
            hasOnchainData: false,
            message: '체인상 데이터 확인 기능은 준비 중입니다'
        });
    } catch (error) {
        console.error('❌ 체인상 상태 확인 오류:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Stripe Checkout Session 생성 API
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { walletAddress } = req.body;
        
        if (!walletAddress) {
            return res.status(400).json({ error: '지갑 주소가 필요합니다' });
        }
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: process.env.STRIPE_PRICE_ID || 'price_1Rr8zCQbNZLwzuc1JKPwJTTX', // 새로 생성된 Price ID
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/cancel.html`,
            subscription_data: {
                metadata: {
                    wallet_address: walletAddress
                }
            }
        });
        
        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('❌ Checkout Session 생성 오류:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// 12. 정적 파일 제공
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'test.html'));
});

// 13. 서버 실행
const port = process.env.PORT || 3000;
app.listen(port, async () => {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ 데이터베이스 연결 성공');
        
        // 테이블 생성
        await createTables();
        
    } catch (err) {
        console.error('❌ 데이터베이스 연결 실패:', err);
    }
    console.log(`🚀 서버가 http://0.0.0.0:${port} 에서 실행 중입니다.`);
    console.log(`🔗 Stripe 웹훅 엔드포인트: http://0.0.0.0:${port}/stripe-webhook`);
});
