console.log('netlify/functions/api/server.js: Module loaded');
const express = require('express');
const serverless = require('serverless-http');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors({ origin: 'http://localhost:3001' }));
app.use(express.json());

// Log incoming requests as seen by Express
app.use((req, res, next) => {
  console.log(`netlify/functions/api/server.js: Express received request. Method: ${req.method}, Path: ${req.path}, Original URL: ${req.originalUrl}`);
  next();
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Auth routes
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, business_name } = req.body;
    
    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });
    
    if (authError) throw authError;
    
    // Update profile with business name
    if (authData.user) {
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ business_name })
        .eq('id', authData.user.id);
      
      if (profileError) throw profileError;
    }
    
    // Create JWT token
    const token = jwt.sign({ id: authData.user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ user: authData.user, token });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Sign in with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    
    if (authError) throw authError;
    
    // Create JWT token
    const token = jwt.sign({ id: authData.user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ user: authData.user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/user', authMiddleware, async (req, res) => {
  try {
    // Get user profile
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();
    
    if (error) throw error;
    
    res.json({ profile });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Quotes routes
app.post('/quotes', authMiddleware, async (req, res) => {
  try {
    const { client_name, client_email, job_description, options } = req.body;
    
    // First create the client
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .upsert({ 
        user_id: req.user.id,
        name: client_name,
        email: client_email
      }, { onConflict: 'user_id, email' })
      .select()
      .single();
    
    if (clientError) throw clientError;
    
    // Create the quote
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .insert({
        user_id: req.user.id,
        client_id: client.id,
        job_description
      })
      .select()
      .single();
    
    if (quoteError) throw quoteError;
    
    // Create the options
    const quoteOptionsData = options.map((option, index) => ({
      quote_id: quote.id,
      title: option.title,
      description: option.description,
      price: option.price,
      option_order: index + 1
    }));
    
    const { data: quoteOptions, error: optionsError } = await supabase
      .from('quote_options')
      .insert(quoteOptionsData)
      .select();
    
    if (optionsError) throw optionsError;
    
    res.json({ quote, options: quoteOptions });
  } catch (error) {
    console.error('Create quote error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/quotes', authMiddleware, async (req, res) => {
  try {
    const { data: quotes, error } = await supabase
      .from('quotes')
      .select(`
        *,
        clients (name, email),
        quote_options (*)
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ quotes });
  } catch (error) {
    console.error('Get quotes error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/quotes/:id/send', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    // First check if the quote belongs to the user
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();
    
    if (quoteError) throw quoteError;
    
    // Update quote status to 'sent'
    const { data: updatedQuote, error: updateError } = await supabase
      .from('quotes')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();
    
    if (updateError) throw updateError;
    
    res.json({ quote: updatedQuote });
  } catch (error) {
    console.error('Send quote error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public routes
app.get('/public/quotes/:uniqueLinkId', async (req, res) => {
  try {
    const { uniqueLinkId } = req.params;
    
    // Get quote data
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select(`
        *,
        clients (name, email),
        quote_options (*)
      `)
      .eq('unique_link_id', uniqueLinkId)
      .single();
    
    if (quoteError) throw quoteError;
    
    // Get business name
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('business_name')
      .eq('id', quote.user_id)
      .single();
    
    if (profileError) throw profileError;
    
    // Don't send user_id to the client
    const safeQuote = {
      ...quote,
      business_name: profile.business_name,
      user_id: undefined
    };
    
    res.json({ quote: safeQuote });
  } catch (error) {
    console.error('Get public quote error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/public/quotes/:uniqueLinkId/accept', async (req, res) => {
  try {
    const { uniqueLinkId } = req.params;
    const { option_id } = req.body;
    
    // Get quote data
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select(`
        *,
        clients (name, email)
      `)
      .eq('unique_link_id', uniqueLinkId)
      .single();
    
    if (quoteError) throw quoteError;
    
    // Check if quote is in 'sent' status
    if (quote.status !== 'sent') {
      return res.status(400).json({ error: 'Quote is not in "sent" status' });
    }
    
    // Get option data
    const { data: option, error: optionError } = await supabase
      .from('quote_options')
      .select('*')
      .eq('id', option_id)
      .eq('quote_id', quote.id)
      .single();
    
    if (optionError) throw optionError;
    
    // Get business name
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('business_name')
      .eq('id', quote.user_id)
      .single();
    
    if (profileError) throw profileError;
    
    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${profile.business_name} - ${option.title}`,
              description: option.description || quote.job_description
            },
            unit_amount: Math.round(option.price * 100) // Convert to cents
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment/success?quote_id=${quote.id}`,
      cancel_url: `${process.env.FRONTEND_URL}/q/${uniqueLinkId}?cancelled=true`,
      customer_email: quote.clients.email,
      metadata: {
        quote_id: quote.id,
        option_id: option_id,
        business_id: quote.user_id
      }
    });
    
    // Update quote with accepted option and Stripe session ID
    const { error: updateError } = await supabase
      .from('quotes')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
        accepted_option_id: option_id,
        stripe_checkout_session_id: session.id
      })
      .eq('id', quote.id);
    
    if (updateError) throw updateError;
    
    res.json({ checkout_url: session.url });
  } catch (error) {
    console.error('Accept quote error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle payment success
app.get('/public/payment/success', async (req, res) => {
  try {
    const { quote_id } = req.query;
    
    // Update quote status to 'paid'
    const { error } = await supabase
      .from('quotes')
      .update({
        status: 'paid'
      })
      .eq('id', quote_id);
    
    if (error) throw error;
    
    res.json({ success: true });
  } catch (error) {
    console.error('Payment success error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Catch-all for 404s within Express
app.use('*', (req, res) => {
  console.log(`netlify/functions/api/server.js: Express 404 - No route matched for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `Express route not found: ${req.method} ${req.originalUrl}` });
});

// Export the Express app wrapped with serverless-http, adding event logging
const serverlessHandler = serverless(app);
module.exports.handler = async (event, context) => {
  console.log(`netlify/functions/api/server.js: Handler invoked. Event path: ${event.path}`);
  // console.log('Event Headers:', JSON.stringify(event.headers, null, 2)); // Uncomment for more debug info
  return serverlessHandler(event, context);
};
