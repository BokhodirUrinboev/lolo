using System.Text;

namespace Demo;

public static class TextUtils
{
    public static string Capitalize(string text) =>
        string.IsNullOrEmpty(text) ? text : char.ToUpperInvariant(text[0]) + text[1..];

    public static string Slugify(string text)
    {
        var sb = new StringBuilder();
        var dash = false;
        foreach (var c in text.Trim().ToLowerInvariant())
        {
            if (c is ' ' or '-')
            {
                dash = sb.Length > 0;
                continue;
            }
            if (c is (>= 'a' and <= 'z') or (>= '0' and <= '9'))
            {
                if (dash) sb.Append('-');
                dash = false;
                sb.Append(c);
            }
        }
        return sb.ToString();
    }
}
