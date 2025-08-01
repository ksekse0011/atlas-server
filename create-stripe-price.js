// create-stripe-price.js
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createPrice() {
    try {
        // 먼저 Product 생성 (이미 있다면 건너뛰기)
        const product = await stripe.products.create({
            name: 'Atlas Premium Subscription',
            description: 'Premium blockchain data access subscription',
        });
        
        console.log('✅ Product 생성됨:', product.id);
        
        // Price 생성
        const price = await stripe.prices.create({
            product: product.id,
            unit_amount: 1000, // $10.00 (cents)
            currency: 'usd',
            recurring: {
                interval: 'month',
            },
        });
        
        console.log('✅ Price 생성됨:', price.id);
        console.log('📋 사용할 Price ID:', price.id);
        
    } catch (error) {
        console.error('❌ 오류:', error);
    }
}

createPrice(); 