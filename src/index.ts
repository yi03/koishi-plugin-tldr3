// --- START OF FILE index.ts ---

import { Context, Schema, Session, Time, Logger, h } from 'koishi'
import axios from 'axios'

export const name = 'tldr3'
export const description = '太长不看 - AI总结群聊消息 (交互式范围选择, 数据库存储)'
export const usage = '使用 tldr3 命令启动消息总结流程，按照提示操作即可指定总结范围。\n消息记录会自动存储并在设定天数后清理。'

// 数据库模型定义
declare module 'koishi' {
  interface Tables {
    tldr_messages: TldrMessage
  }
}

export interface TldrMessage {
  id: number
  messageId: string
  guildId: string
  userId: string
  username: string
  content: string
  timestamp: Date
}

// 插件配置
export interface Config {
  openaiEndpoint: string
  openaiApiKey: string
  openaiModel: string
  commandTimeout: number
  Textlimit: number
  maxMessageAgeDays: number
}

export const Config: Schema<Config> = Schema.object({
  openaiEndpoint: Schema.string().description('OpenAI API 端点').default('https://api.openai.com/v1/chat/completions'),
  openaiApiKey: Schema.string().description('OpenAI API 密钥').required(),
  openaiModel: Schema.string().description('使用的 OpenAI 模型').default('gpt-3.5-turbo'),
  commandTimeout: Schema.number().description('命令交互超时时间（秒），0 表示永不超时').default(120),
  Textlimit: Schema.number().description('总结原文的最大字符数限制').default(60000),
  maxMessageAgeDays: Schema.number().description('消息在数据库中保留的最长天数，0 表示永久保留 (不推荐)').default(7)
})

// 插件实现
export const using = ['database'] as const
const logger = new Logger('tldr3') // 日志记录器

export function apply(ctx: Context, config: Config) {
  // 定义数据库表结构
  ctx.model.extend('tldr_messages', {
    id: 'unsigned', messageId: 'string', guildId: 'string', userId: 'string',
    username: 'string', content: 'text', timestamp: 'timestamp',
  }, { autoInc: true, indexes: [['guildId', 'timestamp'], ['guildId', 'messageId']] }) // 索引优化查询

  // 会话状态 (内存存储)
  const sessionStore: Record<string, { userId: string; guildId: string; stage: 'start' | 'waitForSecond' | 'processing' | 'completed'; firstMessageId?: string; secondMessageId?: string; timer?: NodeJS.Timeout }> = {}

  // tldr 命令处理
  ctx.command('tldr3', '启动交互式消息总结流程')
    .action(async ({ session }) => {
      if (!session || !session.guildId || !session.userId) return '该命令只能在群组中使用。'

      const sessionId = `${session.guildId}-${session.userId}`

      // 防止用户重复启动任务
      if (sessionStore[sessionId] && sessionStore[sessionId].stage !== 'completed' && sessionStore[sessionId].stage !== 'processing') {
        return '您当前有一个总结任务正在进行中，请先完成或等待超时。'
      }

      // 清理旧会话和定时器
      if (sessionStore[sessionId]?.timer) {
        clearTimeout(sessionStore[sessionId].timer);
      }
      delete sessionStore[sessionId];

      // 创建新会话状态
      sessionStore[sessionId] = { userId: session.userId, guildId: session.guildId, stage: 'start' }

      // 设置交互超时定时器
      if (config.commandTimeout > 0) {
        sessionStore[sessionId].timer = setTimeout(() => {
          if (sessionStore[sessionId] && sessionStore[sessionId].stage !== 'completed' && sessionStore[sessionId].stage !== 'processing') {
            logger.info(`[TLDR Timeout] Session ${sessionId} timed out.`);
            delete sessionStore[sessionId];
            // 发送超时通知 (忽略发送失败)
            session.send('由于长时间未操作，tldr 总结任务已自动取消。').catch(err => logger.warn('[TLDR Timeout] 发送取消消息失败:', err.message));
          }
        }, config.commandTimeout * 1000);
      }

      return 'tldr 总结任务已启动。\n请【回复】你想要作为【总结起点】的那条消息，并发送数字【1】。'
    })

  // 消息事件监听器
  ctx.on('message', async (session: Session) => {

    // 1. 消息存储
    let prefix: string | undefined;
    if (typeof ctx.options.prefix === 'string') {
      prefix = ctx.options.prefix;
    } else if (Array.isArray(ctx.options.prefix) && ctx.options.prefix.length > 0 && typeof ctx.options.prefix[0] === 'string') {
      prefix = ctx.options.prefix[0];
    }
    const isCommand = prefix && session.content?.startsWith(prefix);
    const isBot = session.author?.isBot;
    const shouldStore = !!(session.guildId && session.userId && session.messageId && session.content && !isCommand && !isBot);

    if (shouldStore) {
      try {
        const username = session.author?.name || session.author?.nickname || session.username || session.userId || 'UnknownUser';
        const timestamp = session.timestamp ? new Date(session.timestamp) : new Date();

        await ctx.database.create('tldr_messages', {
          messageId: session.messageId,
          guildId: session.guildId,
          userId: session.userId,
          username: username,
          content: session.content,
          timestamp: timestamp,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[TLDR Store] Failed to store message ID ${session.messageId}: ${errorMessage}`, error);
      }
    }

    // 2. TLDR 交互处理
    // 过滤非相关消息 (不是回复、缺少必要信息)
    if (!session.quote || !session.guildId || !session.userId || !session.content) {
      return;
    }

    const sessionId = `${session.guildId}-${session.userId}`;
    const collectSession = sessionStore[sessionId];

    // 过滤无效会话状态或非当前用户操作
    if (!collectSession || collectSession.userId !== session.userId || collectSession.stage === 'completed' || collectSession.stage === 'processing') {
      return;
    }

    const quotedMessageId = session.quote.id;
    const botUserId = session.bot?.userId || ctx.bots[0]?.userId;
    const atBotRegex = new RegExp(`<at id="${botUserId}"[^>]*/>\\s*`);
    const trimmedContent = session.content.replace(atBotRegex, '').trim();

    // 处理步骤 1: 回复起点消息 + "1"
    if (collectSession.stage === 'start' && trimmedContent === '1') {
      // 检查起点消息是否存在于数据库
      try {
        const startMsgExists = await ctx.database.get('tldr_messages', { guildId: session.guildId, messageId: quotedMessageId });
        if (startMsgExists.length === 0) {
          logger.warn(`[TLDR Step 1] Quoted start message (ID: ${quotedMessageId}) not found in DB for guild ${session.guildId}.`);
          // 清理会话并通知用户错误
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          await session.send(`错误：引用的【起点】消息 (ID: ${quotedMessageId}) 未在数据库中找到。\n可能原因：消息过旧已被清理、从未被机器人记录。\n\ntldr 任务已取消，请重新开始。`);
          return;
        }
      } catch (dbError) {
        logger.error(`[TLDR Step 1] Database error checking start message existence for guild ${session.guildId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        if (collectSession.timer) clearTimeout(collectSession.timer);
        delete sessionStore[sessionId];
        await session.send('错误：检查引用的起点消息时数据库出错，tldr 任务已取消。请稍后再试或联系管理员。').catch(() => {/*ignore*/ });
        return;
      }

      // 消息存在，继续流程
      if (collectSession.timer) {
        clearTimeout(collectSession.timer);
        collectSession.timer = undefined; // 清除定时器引用
      }
      collectSession.firstMessageId = quotedMessageId;
      collectSession.stage = 'waitForSecond';

      // 重置超时定时器 (如果配置了超时)
      if (config.commandTimeout > 0) {
        collectSession.timer = setTimeout(() => {
          if (sessionStore[sessionId] && sessionStore[sessionId].stage === 'waitForSecond') {
            logger.info(`[TLDR Timeout] Session ${sessionId} timed out at step 2.`);
            delete sessionStore[sessionId];
            session.send('由于长时间未操作，tldr 总结任务已自动取消。').catch(err => logger.warn('[TLDR Timeout] 发送取消消息失败:', err.message));
          }
        }, config.commandTimeout * 1000);
      }
      try {
        await session.send('已记录起点消息。\n请【回复】你想要作为【总结终点】的那条消息，并发送数字【2】。');
      }
      catch (sendError) { logger.warn(`[TLDR Step 2 Prompt] 发送步骤2提示失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`); }
      return;
    }

    // 处理步骤 2: 回复终点消息 + "2"
    if (collectSession.stage === 'waitForSecond' && trimmedContent === '2') {
      if (!collectSession.firstMessageId) {
        logger.error(`[TLDR Step 2] Internal error: firstMessageId missing for session ${sessionId}.`);
        if (collectSession.timer) clearTimeout(collectSession.timer);
        delete sessionStore[sessionId];
        try { await session.send('内部错误：未记录起点消息，任务已取消，请重新开始。'); } catch (_) { /* 忽略发送失败 */ }
        return;
      }

      // 检查终点消息是否存在于数据库
      try {
        const endMsgExists = await ctx.database.get('tldr_messages', { guildId: session.guildId, messageId: quotedMessageId });
        if (endMsgExists.length === 0) {
          logger.warn(`[TLDR Step 2] Quoted end message (ID: ${quotedMessageId}) not found in DB for guild ${session.guildId}.`);
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          await session.send(`错误：引用的【终点】消息 (ID: ${quotedMessageId}) 未在数据库中找到。\n可能原因：消息过旧已被清理、从未被机器人记录，或来自其他群组。\n\ntldr 任务已取消，请重新开始或选择其他终点消息。`);
          return;
        }
      } catch (dbError) {
        logger.error(`[TLDR Step 2] Database error checking end message existence for guild ${session.guildId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        if (collectSession.timer) clearTimeout(collectSession.timer);
        delete sessionStore[sessionId];
        await session.send('错误：检查引用的终点消息时数据库出错，tldr 任务已取消。请稍后再试或联系管理员。').catch(() => {/*ignore*/ });
        return;
      }

      // 消息存在，开始处理
      if (collectSession.timer) {
        clearTimeout(collectSession.timer);
        collectSession.timer = undefined; // 清除定时器引用
      }
      collectSession.secondMessageId = quotedMessageId;
      collectSession.stage = 'processing';

      // 异步执行总结
      processMessagesFromDb(ctx, config, session, collectSession.firstMessageId, collectSession.secondMessageId)
        .then(result => {
          // 只有在会话仍处于 processing 状态时才标记为 completed
          if (sessionStore[sessionId]?.stage === 'processing') {
            sessionStore[sessionId].stage = 'completed';
          }
          // 尝试发送结果
          session.send(result).catch(sendError => {
            logger.warn(`[TLDR Send Result] 发送总结结果失败 for session ${sessionId}: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          });
        })
        .catch(error => {
          logger.error(`[TLDR Process Background] Unexpected error during processing for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`, error);
          // 即使出错，也标记会话结束（如果还存在且状态正确）
          if (sessionStore[sessionId]?.stage === 'processing') {
             sessionStore[sessionId].stage = 'completed';
          }
          // 尝试发送错误通知
          session.send('处理总结时发生意外错误，任务已终止。').catch(() => { /* 忽略发送失败 */ });
        })
        .finally(() => {
          // 稍微延迟后清理会话状态，确保之前的操作完成
          setTimeout(() => {
            delete sessionStore[sessionId];
          }, 500);
        });

      try {
        await session.send(`已收到终点消息，正在获取消息记录并请求 AI 总结，请稍候... (这可能需要一点时间)`);
      } catch (sendError) {
        logger.warn(`[TLDR Processing Prompt] 发送处理中提示失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
      }
      return; // 交互处理完成
    }
  }); // 消息事件监听器结束

  // 定时清理旧消息
  ctx.setInterval(async () => {
    // 配置为0则禁用清理
    if (config.maxMessageAgeDays <= 0) return;

    const cutoffDate = new Date(Date.now() - config.maxMessageAgeDays * Time.day);
    logger.info(`[TLDR Pruning] Running automatic message pruning older than ${cutoffDate.toISOString()}...`);
    try {
      const query = { timestamp: { $lt: cutoffDate } };
      const result = await ctx.database.remove('tldr_messages', query);

      // 记录数据库 remove 操作结果
      if (typeof result === 'object' && result !== null && 'removed' in result) {
        logger.info(`[TLDR Pruning] Pruning complete. Removed ${result.removed} old message records.`);
      } else {
        logger.warn(`[TLDR Pruning] Pruning complete, but result format was unexpected: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TLDR Pruning] Error during automatic message pruning: ${errorMessage}`, error);
    }
  }, Time.hour); // 每小时运行一次

} // apply 函数结束


/**
 * 核心: 消息处理与 AI 总结
 * @param ctx Koishi 上下文
 * @param config 插件配置
 * @param session 当前会话 (需要 session 获取 guildId)
 * @param firstMsgId 起点消息 ID
 * @param secondMsgId 终点消息 ID
 * @returns 格式化后的总结结果或用户友好的错误信息
 */
async function processMessagesFromDb(
  ctx: Context,
  config: Config,
  session: Session,
  firstMsgId: string,
  secondMsgId: string
): Promise<string> {
  const guildId = session.guildId;
  if (!guildId) {
    logger.error('[TLDR Process] Error: Missing guildId in session.');
    return '错误：无法获取当前群组 ID。';
  }

  try {
    // 1. 查询起点终点消息时间戳
    const startQuery = { guildId: guildId, messageId: firstMsgId };
    const endQuery = { guildId: guildId, messageId: secondMsgId };
    const [startMsgArr, endMsgArr] = await Promise.all([
      ctx.database.get('tldr_messages', startQuery),
      ctx.database.get('tldr_messages', endQuery)
    ]);

    // 检查消息是否存在
    if (startMsgArr.length === 0 || endMsgArr.length === 0) {
      let notFound: string[] = [];
      if (startMsgArr.length === 0) notFound.push("起点");
      if (endMsgArr.length === 0) notFound.push("终点");
      const missingIds = `${notFound.includes("起点") ? firstMsgId : ''} ${notFound.includes("终点") ? secondMsgId : ''}`.trim();
      logger.warn(`[TLDR Process] ${notFound.join("和")} message(s) (${missingIds}) not found in DB for guild ${guildId}.`);
      return `错误：无法在数据库中找到引用的${notFound.join("和")}消息 (ID: ${missingIds})。\n它们可能已被清理、从未被记录或来自其他群组。`;
    }

    const startMsg = startMsgArr[0];
    const endMsg = endMsgArr[0];

    // 2. 确定时间范围 (允许反向选择)
    const minTimestamp = startMsg.timestamp <= endMsg.timestamp ? startMsg.timestamp : endMsg.timestamp;
    const maxTimestamp = startMsg.timestamp >= endMsg.timestamp ? startMsg.timestamp : endMsg.timestamp;

    // 3. 查询范围内所有消息 (按时间排序)
    const rangeQuery = {
      guildId: guildId,
      timestamp: { $gte: minTimestamp, $lte: maxTimestamp } // 包含边界
    };
    // Koishi v4+ 的 sort 写法
    const messagesToSummarize = await ctx.database.get('tldr_messages', rangeQuery, { sort: { timestamp: 'asc' } });


    if (messagesToSummarize.length === 0) {
      logger.warn(`[TLDR Process] No messages found in the specified time range for guild ${guildId}.`);
      return '提示：在您选择的起点和终点消息之间（包括这两条消息）没有找到其他可供总结的消息记录。';
    }

    // 4. 格式化消息供 AI 处理
    let totalLength = 0;
    const formattedMessages = messagesToSummarize.map(msg => {
      let textContent = '';
      try {
        // 使用 h.parse 解析消息元素
        const elements = h.parse(msg.content || '');
        textContent = elements.map(el => {
          if (el.type === 'text') return el.attrs.content || '';
          if (el.type === 'at') {
            const nameAttr = el.attrs.name || el.attrs.nickname;
            return nameAttr ? `@${nameAttr}` : `<at id="${el.attrs.id}"/>`; // 优先显示名字
          }
          // 简化常见元素表示
          if (el.type === 'img' || el.type === 'image') return '[图片]';
          if (el.type === 'face') return `[表情:${el.attrs.id || el.attrs.name || '未知'}]`; // 尝试获取 name
          if (el.type === 'record' || el.type === 'video' || el.type === 'audio') return '[语音/视频]';
          return ''; // 忽略其他复杂元素
        }).join('');
      } catch (parseError) {
        // 解析失败时的后备处理
        logger.warn(`[TLDR Process] Error parsing message content (h.parse) for DB record ${msg.id}: ${parseError instanceof Error ? parseError.message : String(parseError)}. Falling back to basic replacement.`);
        textContent = String(msg.content || '') // 使用原始字符串进行简单替换
          .replace(/<img.*?\/?>/g, '[图片]') // 匹配 <img ...> 或 <img ... />
          .replace(/\[CQ:image,.*?\]/g, '[图片]')
          .replace(/<face id="([^"]*)"[^>]*>/g, '[表情:$1]')
          .replace(/\[CQ:face,id=(\d+).*?\]/g, '[表情:$1]')
          .replace(/<at id="([^"]*)" name="([^"]*)"[^>]*>/g, '@$2')
          .replace(/\[CQ:at,qq=(\d+).*?\]/g, (match, qq) => `@${qq}`) // 简单处理 CQ at
          .replace(/<record.*?\/?>/g, '[语音/视频]')
          .replace(/\[CQ:(?:record|video|audio),.*?\]/g, '[语音/视频]')
          .replace(/<[^>]+>/g, ''); // 移除其他未处理的标签
      }
      // 格式化单行消息
      const line = `${msg.username || msg.userId}: ${textContent.trim()}`;
      totalLength += line.length + 1; // +1 for newline
      return line;
    }).join('\n');

    // 5. 检查总长度限制
    if (totalLength > config.Textlimit) {
      logger.warn(`[TLDR Process] Message content too long (${totalLength} > ${config.Textlimit}) for guild ${guildId}. Aborting summary.`);
      return `总结失败：选择的消息内容总长度过长 (约 ${totalLength} 字符，已超出 ${config.Textlimit} 字符的限制)。请尝试选择更小的消息范围。`;
    }

    // 6. 调用 OpenAI API
    logger.info(`[TLDR Process] Calling OpenAI API for guild ${guildId}. Model: ${config.openaiModel}. Messages count: ${messagesToSummarize.length}, Total length: ${totalLength}`);
    try {
      const response = await axios.post(
        config.openaiEndpoint,
        {
          model: config.openaiModel,
          messages: [
            { role: 'system', content: '你是一个群聊消息总结助手。以下是来自一个群组的一段聊天记录，格式为 "用户名: 消息内容"。请你清晰、客观地总结这段对话的主要内容、讨论点或重要信息。请忽略无关紧要的闲聊、表情符号和格式标记 ([图片], [表情:xx] 等)，专注于核心信息。如果对话中有多方观点，请尽量分别概括。' },
            { role: 'user', content: formattedMessages }
          ],
          temperature: 0.5, // 设置较低的 temperature 适合总结
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.openaiApiKey}`
          },
          timeout: 90000 // 90秒 API 请求超时
        }
      );

      const summary = response?.data?.choices?.[0]?.message?.content;

      if (!summary) {
        logger.error('[TLDR Process] OpenAI API response missing summary content. Response data:', JSON.stringify(response?.data));
        return '总结失败：AI 服务返回的数据格式不正确，未能提取到总结内容。';
      }

      logger.info(`[TLDR Process] OpenAI API call successful for guild ${guildId}. Summary length: ${summary.length}.`);
      // 7. 格式化并返回成功结果
      return `【太长不看】消息总结 (基于 ${messagesToSummarize.length} 条消息)：\n--------------------\n${summary.trim()}`;

    } catch (apiError: any) {
      // 处理 API 调用错误
      logger.error('[TLDR Process] Error calling OpenAI API:', apiError?.message || apiError);
      let userErrorMessage = `总结失败: 调用 AI 服务时遇到错误。`;

      if (axios.isAxiosError(apiError)) {
        if (apiError.response) {
          const status = apiError.response.status;
          const data = apiError.response.data;
          logger.error(`[TLDR Process] OpenAI API error details: Status ${status}, Data: ${JSON.stringify(data)}`);
          let detail = `状态码 ${status}.`;
          const errorMsg = data?.error?.message || '';
          if (status === 401) detail = 'API 密钥无效或权限不足。';
          else if (status === 429) detail = '请求过于频繁或超出配额。';
          else if (status === 400) detail = `请求格式错误或模型不支持 (${errorMsg || '无详细信息'})。`;
          else if (status >= 500) detail = `AI 服务端内部错误 (${errorMsg || '无详细信息'})。`;
          else if (errorMsg) detail = `错误 ${status}: ${errorMsg}`;
          userErrorMessage = `总结失败: 请求 AI 服务出错 (${detail}) 请检查配置或稍后再试。`;
        } else if (apiError.request) {
          logger.error('[TLDR Process] OpenAI API no response received (timeout or network issue).');
          userErrorMessage = `总结失败: 请求 AI 服务超时或网络连接中断。`;
        } else {
          userErrorMessage = `总结失败: 准备请求 AI 服务时发生内部错误 (${apiError.message})。`;
        }
      } else {
        userErrorMessage = `总结失败: 处理 AI 请求时发生未知内部错误 (${apiError?.message || 'Unknown Error'})。`;
      }
      return userErrorMessage;
    }

  } catch (dbError: any) {
    // 处理数据库查询错误
    const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
    logger.error(`[TLDR Process] Database error during message processing for guild ${guildId}: ${errorMessage}`, dbError);
    return `总结失败: 查询消息记录时数据库出错 (${errorMessage})。请联系管理员检查日志。`;
  }
} // processMessagesFromDb 函数结束

// --- END OF FILE index.ts ---