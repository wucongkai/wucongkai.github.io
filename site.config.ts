// 修改此文件即可更新个人信息。没有填写的邮箱不会显示。
export const site = {
  name: 'wucongkai',
  title: "wucongkai's Wiki",
  description: 'wucongkai 的个人主页：项目、文章、学习笔记与论文成果。',
  url: 'https://wucongkai.github.io',
  github: 'https://github.com/wucongkai',
  email: 'hduwucongkai@163.com',
  bio: [
    '你好，我是 wucongkai。欢迎来到我的个人主页。',
    '这里用来整理项目、文章和学习笔记。关于我的更多介绍，之后会慢慢补充。',
  ],
  projects: [
    {
      name: '个人 Wiki',
      description: '这个网站。把零散的记录整理成可以持续更新的个人知识库。',
      href: '/',
      label: '正在搭建',
    },
    {
      name: 'UU 远程 macOS 网络连接修复',
      description: '记录 UU 远程在 macOS 特定网络下无法连接的排查过程，提供仅依赖 Python 标准库的本机代理脚本，通过 TCP DNS 与初始 TLS 记录分段恢复连接，保留证书验证，无需修改系统网络设置。',
      href: 'https://github.com/wucongkai/uu-remote-macos-network-fix',
      label: 'Python 工具',
    },
  ],
  publications: [
    {
      title: 'Frequency-Aware Multimodal Fusion Framework for Emotion Recognition in Conversation',
      authors: ['Congkai Wu', 'Jiajia Tang', 'Changchen Zhao', 'Songqing Zuo', 'Wanzeng Kong'],
      highlightAuthor: 'Congkai Wu',
      journal: 'Multimedia Systems',
      volume: '32',
      articleNumber: '552',
      published: '2026-08-27',
      doi: '10.1007/s00530-026-02630-1',
      description: '提出用于对话情绪识别的频率感知多模态融合框架 FAMF，通过 FrequencyAdapter 与频率感知交叉注意力（FACA）保留模态差异、情绪突变等高频线索，缓解深层融合中的过度平滑。',
      results: '在 IEMOCAP 和 MELD 数据集上的加权 F1 分别达到 73.05% 和 66.75%。',
    },
  ],
};
