import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

// Express app ko initialize karein
const app = express();
const PORT = process.env.PORT || 3001;

// --- SECURITY MIDDLEWARE ---
// Security headers set karein
app.use(helmet());

// CORS configuration (production mein specific origins allow karein)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

// Rate limiting - abuse se bachne ke liye
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // TEMPORARY: raised for testing — lower this back down before production
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing with size limit (DDOS protection)
app.use(express.json({ limit: '10kb' }));

// --- ENVIRONMENT VALIDATION ---
if (!process.env.GROQ_API_KEY) {
  console.error("❌ FATAL ERROR: GROQ_API_KEY .env file mein nahin mil rahi hai.");
  process.exit(1);
}

// Groq client ko initialize karein
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Utility: Markdown code blocks hataane ke liye
const cleanCodeResponse = (text) => {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(jsx|js|javascript|typescript|ts|html|css|json)?\n/i, '');
  cleaned = cleaned.replace(/^```(jsx|js|javascript|typescript|ts|html|css|json)?/i, '');
  cleaned = cleaned.replace(/```$/g, '');
  return cleaned.trim();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'AI Code Generator API'
  });
});

// Main API endpoint
app.post('/api/generate', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[${requestId}] Request received for type:`, req.body.type);

  try {
    const { prompt, type } = req.body;

    // --- VALIDATION ---
    if (!prompt || !type) {
      console.error(`[${requestId}] Validation Error: Missing fields`);
      return res.status(400).json({
        error: 'Prompt and type are required.',
        requestId
      });
    }

    if (typeof prompt !== 'string' || typeof type !== 'string') {
      return res.status(400).json({
        error: 'Invalid data types. Prompt and type must be strings.',
        requestId
      });
    }

    if (prompt.length > 1000) {
      return res.status(400).json({
        error: 'Prompt is too long. Maximum 1000 characters allowed.',
        requestId
      });
    }

    if (prompt.length < 5) {
      return res.status(400).json({
        error: 'Prompt is too short. Please provide more details.',
        requestId
      });
    }

    const validTypes = ['frontend', 'backend', 'fullstack', 'api'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid type. Allowed types: ${validTypes.join(', ')}`,
        requestId
      });
    }

    // --- PROMPT CONSTRUCTION ---
    const systemInstructions = {
      frontend: `You are an expert React developer. Generate a modern, responsive React functional component using JSX and Tailwind CSS.
Rules:
1. Return ONLY the code, no markdown, no explanations, no comments
2. Use proper React hooks if needed
3. Ensure the code is complete and runnable
4. Use Tailwind classes for styling
5. Export default the component`,

      backend: `You are an expert Node.js developer. Generate a complete Express.js API server.
Rules:
1. Return ONLY the code, no markdown, no explanations, no comments
2. Include all necessary imports (express, cors, etc.)
3. Include error handling middleware
4. Use proper async/await patterns
5. Export the app or start the server
6. Include comments only if absolutely necessary for complex logic`,

      fullstack: `Generate both frontend React component and backend Express API code structure.
Rules:
1. Provide clear separation between frontend and backend code
2. Show how they connect (API endpoints)
3. No markdown, no explanations outside code`,

      api: `Generate REST API endpoint logic only.
Rules:
1. Focus on controller logic
2. Include input validation
3. Error handling included
4. No markdown, no explanations`
    };

    console.log(`[${requestId}] Generating content...`);

    // --- AI GENERATION WITH TIMEOUT ---
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI_GENERATION_TIMEOUT')), 30000)
    );

    const generationPromise = groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemInstructions[type] },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 4096
    });

    const result = await Promise.race([generationPromise, timeoutPromise]);

    const rawCode = result?.choices?.[0]?.message?.content;

    if (!rawCode || rawCode.trim().length === 0) {
      throw new Error('EMPTY_RESPONSE');
    }

    const code = cleanCodeResponse(rawCode);

    console.log(`[${requestId}] Generation successful. Code length: ${code.length}`);

    res.json({
      code,
      requestId,
      type,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message);

    let statusCode = 500;
    let errorMessage = 'Failed to generate code. Please try again.';

    if (error.message === 'AI_GENERATION_TIMEOUT') {
      statusCode = 504;
      errorMessage = 'AI generation timed out. Please try a simpler prompt.';
    } else if (error.message === 'EMPTY_RESPONSE') {
      statusCode = 500;
      errorMessage = 'AI returned empty response.';
    } else if (error.status === 401 || error.message?.toLowerCase().includes('invalid api key')) {
      statusCode = 500;
      errorMessage = 'Server configuration error. Please contact support.';
      console.error('Invalid Groq API Key detected!');
    } else if (error.status === 429) {
      statusCode = 429;
      errorMessage = 'Rate limit exceeded on AI service. Please try again later.';
    }

    res.status(statusCode).json({
      error: errorMessage,
      requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found. Use POST /api/generate or GET /health' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId || 'unknown'
  });
});

// Server start
const server = app.listen(PORT, () => {
  console.log(`✅ Server is listening on http://localhost:${PORT}`);
  console.log(`🔒 Rate limiting enabled: ${limiter.max || 'custom'} requests per 15 minutes`);
  console.log(`🏥 Health check available at: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

export default app;