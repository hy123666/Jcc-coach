---
frameworks:
- Pytorch
license: Apache License 2.0
tasks:
- ocr-detection

#model-type:
##如 gpt、phi、llama、chatglm、baichuan 等
#- gpt

#domain:
##如 nlp、cv、audio、multi-modal
#- nlp

#language:
##语言代码列表 https://help.aliyun.com/document_detail/215387.html?spm=a2c4g.11186623.0.0.9f8d7467kni6Aa
#- cn

#metrics:
##如 CIDEr、Blue、ROUGE 等
#- CIDEr

#tags:
##各种自定义，包括 pretrained、fine-tuned、instruction-tuned、RL-tuned 等训练方法和其他
#- pretrained

#tools:
##如 vllm、fastchat、llamacpp、AdaSeq 等
#- vllm
- ocr-recognition
language:
  - zh
tags:
  - ocr
  - dbnet
  - paddleocr
  - rapidocr
---

### RapidOCR模型托管仓库

本仓库用来托管[RapidOCR](https://github.com/RapidAI/RapidOCR)项目中个各个模型文件。

大家可以根据自己需要单独下载使用。


#### SDK下载
```bash
#安装ModelScope
pip install modelscope
```
```python
#SDK模型下载
from modelscope import snapshot_download
model_dir = snapshot_download('RapidAI/RapidOCR')
```
#### Git下载
```
#Git模型下载
git clone https://www.modelscope.cn/RapidAI/RapidOCR.git
```
