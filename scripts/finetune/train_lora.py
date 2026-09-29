"""
QLoRA fine-tune of qwen2.5-coder:7b on Agent Lolo trajectories (plan item 14).

  node dist/eval.js export --out dataset.jsonl --exclude <held-out task ids> eval/results/*/
  pip install torch --index-url https://download.pytorch.org/whl/cu128   # CUDA GPU, ~9 GB VRAM for 7B QLoRA
  pip install unsloth trl datasets
  python scripts/finetune/train_lora.py dataset.jsonl out/lolo-lora
  # → out/lolo-lora/merged (16-bit safetensors); Ollama quantizes it on import:
  ollama create lolo-coder -q q4_K_M -f scripts/finetune/Modelfile
  node dist/eval.js run --runs 2 --model lolo-coder --filter <held-out id>   # compare with the base model

Only the assistant replies (tool calls, plans) are trained; prompts are masked.
Samples come from successful runs only, and invalid/stuck steps are dropped by the export.
Hold some eval tasks out of the dataset (--exclude), or the eval measures memorization.
Stop Ollama's loaded models first (`ollama stop <model>`): training needs the GPU memory.
`--gguf` also writes a GGUF through llama.cpp (needs a C++ compiler).
"""
import sys

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only

args = [a for a in sys.argv[1:] if not a.startswith("--")]
data_file, out_dir = args[0], args[1]
epochs = float(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--epochs=")), "2"))
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
        num_train_epochs=epochs,
        learning_rate=1e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=5,
        save_strategy="no",
        bf16=True,
        dataset_num_proc=1,  # Windows: no fork
    ),
)
trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
trainer.train()

model.save_pretrained(f"{out_dir}/adapter")
tokenizer.save_pretrained(f"{out_dir}/adapter")
model.save_pretrained_merged(f"{out_dir}/merged", tokenizer, save_method="merged_16bit")
if "--gguf" in sys.argv:
    model.save_pretrained_gguf(f"{out_dir}/gguf", tokenizer, quantization_method="q4_k_m")
print(f"done: {out_dir}/merged")
