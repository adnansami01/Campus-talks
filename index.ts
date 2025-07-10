import { createClient } from 'npm:@supabase/supabase-js@2.39.3';
import OpenAI from 'npm:openai@4.24.0';
// This Edge Function summarizes message threads using OpenAI
Deno.serve(async (req)=>{
  try {
    // Parse request body
    const { threadId } = await req.json();
    if (!threadId) {
      return new Response(JSON.stringify({
        error: 'Thread ID is required'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Get authorization header from request
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({
        error: 'Authorization header is required'
      }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Initialize Supabase client with user's JWT
    const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: Deno.env.get('OPENAI_API_KEY') ?? ''
    });
    // Check if user has access to this thread
    const { data: participantData, error: participantError } = await supabaseClient.from('thread_participants').select('user_id').eq('thread_id', threadId).single();
    if (participantError || !participantData) {
      return new Response(JSON.stringify({
        error: 'You do not have access to this thread or thread does not exist'
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Get thread details
    const { data: threadData, error: threadError } = await supabaseClient.from('threads').select('title').eq('id', threadId).single();
    if (threadError || !threadData) {
      return new Response(JSON.stringify({
        error: 'Thread not found'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Get messages from the thread
    const { data: messages, error: messagesError } = await supabaseClient.from('messages').select(`
        id,
        content,
        created_at,
        sender_id,
        is_system_message,
        profiles:sender_id (username)
      `).eq('thread_id', threadId).order('created_at', {
      ascending: true
    });
    if (messagesError || !messages || messages.length === 0) {
      return new Response(JSON.stringify({
        error: 'No messages found in this thread'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Format messages for OpenAI
    const formattedMessages = messages.map((msg)=>{
      const username = msg.profiles?.username || 'Unknown User';
      return `${username}: ${msg.content}`;
    }).join('\n\n');
    // Create prompt for OpenAI
    const prompt = `
      Please summarize the following conversation thread titled "${threadData.title || 'Untitled'}":
      
      ${formattedMessages}
      
      Provide a concise summary (2-3 paragraphs) that captures:
      1. The main topics discussed
      2. Any decisions or conclusions reached
      3. Any action items or next steps mentioned
    `;
    // Call OpenAI API
    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that summarizes conversations accurately and concisely.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    });
    const summary = chatCompletion.choices[0].message.content;
    // Store the summary in the database
    const { data: summaryData, error: summaryError } = await supabaseClient.from('thread_summaries').upsert({
      thread_id: threadId,
      summary: summary,
      message_count: messages.length
    }).select();
    if (summaryError) {
      return new Response(JSON.stringify({
        error: 'Failed to save summary',
        details: summaryError
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      summary: summary,
      message_count: messages.length,
      thread_title: threadData.title
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
