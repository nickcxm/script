#!/bin/bash

# 安装 Zsh
sudo apt update
sudo apt install -y zsh
sudo apt install -y git
# 将 Zsh 设置为默认 Shell
chsh -s $(which zsh)

# 安装 Oh My Zsh
sh -c "$(wget https://raw.githubusercontent.com/robbyrussell/oh-my-zsh/master/tools/install.sh -O -)"

# 安装插件
sudo apt install -y autojump fasd
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting

# 清空 ~/.zshrc 文件
> ~/.zshrc

# 写入指定的配置
echo 'export ZSH="$HOME/.oh-my-zsh"' >> ~/.zshrc
echo 'ZSH_THEME="cloud"' >> ~/.zshrc
echo 'ENABLE_CORRECTION="true"' >> ~/.zshrc
echo 'COMPLETION_WAITING_DOTS="true"' >> ~/.zshrc
echo 'plugins=(git extract fasd zsh-autosuggestions zsh-syntax-highlighting)' >> ~/.zshrc
echo 'source $ZSH/oh-my-zsh.sh' >> ~/.zshrc

# 立即应用更改
source ~/.zshrc
# 提示用户重启终端
echo "Zsh 和 Oh My Zsh 已经安装完成，请重启终端以应用更改。"
