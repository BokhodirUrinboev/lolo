"""
QLoRA fine-tune of qwen2.5-coder:7b on Agent Lolo trajectories (plan item 14).

  node dist/eval.js export --out dataset.jsonl eval/results/*/      # passing runs → chat samples
  pip install "unsloth[cu124]" trl datasets                          # CUDA GPU, ~7 GB VRAM for 7B QLoRA
  python scripts/finetune/train_lora.py dataset.jsonl out/lolo-lora
  # → out/lolo-lora/gguf/*.gguf; then: ollama create lolo-coder -f scripts/finetune/Modelfile
  node dist/eval.js run --runs 2 --model lolo-coder                  # compare with the base model

Only the assistant replies (tool calls, plans) are trained; prompts are masked.
Samples come from successful runs only, and invalid/stuck steps are dropped by the export.
Hold some eval tasks out of the dataset, or the eval measures memorization.
"""
import sys

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only

data_file, out_dir = sys.argv[1], sys.argv[2]
MAX_LEN = 8192  # the median sample is ~2k tokens; longer ones are cut from the left by the template

model, tokenizer = FastLanguageModel.from_pretrained("unsloth/Qwen2.5-Coder-7B-Instruct", max_seq_length=MAX_LEN, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    lora_alpha=32,
    lora_dropout=0,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
)

ds = load_dataset("json", data_files=data_file, split="train")
ds = ds.map(lambda r: {"text": tokenizer.apply_chat_template(r["messages"], tokenize=False)}, remove_columns=ds.column_names)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=ds,
    args=SFTConfig(
        output_dir=out_dir,
        dataset_text_field="text",
        max_seq_length=MAX_LEN,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        num_train_epochs=2,
        learning_rate=1e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=10,
        save_strategy="epoch",
        bf16=True,
    ),
)
trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
trainer.train()

model.save_pretrained(f"{out_dir}/adapter")
model.save_pretrained_gguf(f"{out_dir}/gguf", tokenizer, quantization_method="q4_k_m")
print(f"done: {out_dir}/gguf")
